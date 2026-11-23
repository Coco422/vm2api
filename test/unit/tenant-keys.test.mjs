import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-keys-'))
  fs.mkdirSync(path.join(root, 'vms'))
  const store = new ApiKeyStore({ dataDir: path.join(root, 'data') })
  for (const id of ['alice', 'bob']) {
    store.users.insert({ id, username: id, password_hash: 'fixture-only', role: 'user', enabled: true, concurrency: 2 })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, owner_user_id: id, platform: 'anthropic' }),
    )
  }
  const logs = new UsageLogsRepo(store.db)
  t.after(() => {
    store.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  async function call(method, route, body = {}, { user = 'alice', headers = {}, read } = {}) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: { concurrency: { default_key_concurrency: 12 } },
      apiKeyStore: store,
      requestLog: logs,
      requireAuth(req) {
        Object.assign(req, { panelUser: user, panelRole: 'user', panelUserId: user })
        return true
      },
      readBody: read || (async () => body),
      json(_res, status, value) {
        response = { status, ...value }
        return true
      },
    })
    await handler(
      { method, headers: { host: 'localhost', 'content-type': 'application/json', ...headers } },
      {},
      new URL(route, 'http://localhost'),
    )
    return response
  }
  return { store, logs, call, root }
}

test('tenant creates and manages owned client keys without changing VM grants or limits', async (t) => {
  const { store, call } = fixture(t)
  const created = await call('POST', '/api/panel/api-keys', { name: 'editor' })
  assert.equal(created.status, 201, JSON.stringify(created))
  const { id } = created.item
  const original = store.getById(id)
  assert.equal(original.user_id, 'alice')
  assert.equal(original.category, 'oauth')
  assert.equal(original.max_concurrency, 2)
  assert.deepEqual(JSON.parse(original.allowed_vms), ['alice'])
  assert.equal((await call('PATCH', `/api/panel/api-keys/${id}`, { name: 'IDE', status: 'disabled' })).status, 200)
  assert.equal(store.canAccept(store.getById(id)).code, 'api_key_disabled')
  assert.equal((await call('PATCH', `/api/panel/api-keys/${id}`, { status: 'active' })).status, 200)
  store.recordUsage(id, { input_tokens: 10, total_cost: 3 })
  const before = store.getById(id)
  const rotated = await call('POST', `/api/panel/api-keys/${id}/rotate`)
  assert.equal(rotated.status, 200)
  assert.equal(store.authenticate(created.item.key).ok, false)
  assert.equal(store.authenticate(rotated.item.key).ok, true)
  const after = store.getById(id)
  for (const field of ['user_id', 'max_concurrency', 'allowed_vms', 'quota', 'quota_used', 'requests'])
    assert.equal(after[field], before[field])
  assert.equal((await call('DELETE', `/api/panel/api-keys/${id}`)).status, 200)
  assert.equal(store.authenticate(rotated.item.key).ok, false)
  assert.equal(store.getById(id), null)
  assert.ok(store.db.prepare('SELECT deleted_at FROM api_keys WHERE id = ?').get(id).deleted_at)
  assert.equal((await call('POST', '/api/panel/api-keys', { name: 'replacement' })).status, 201)
})

test('a multi-VM tenant grant controls new keys and cumulative admission across clients', async (t) => {
  const { store, call, root } = fixture(t)
  store.db.prepare('UPDATE users SET concurrency = ? WHERE id = ?').run(24, 'alice')
  fs.writeFileSync(
    path.join(root, 'vms/alice-second.json'),
    JSON.stringify({ id: 'alice-second', owner_user_id: 'alice', platform: 'anthropic' }),
  )
  const created = await call('POST', '/api/panel/api-keys', { name: 'two-vms' })
  assert.equal(created.status, 201)
  const first = store.getById(created.item.id)
  assert.equal(first.max_concurrency, 24, 'an explicit user grant must not be capped by the default 12')
  assert.deepEqual(JSON.parse(first.allowed_vms).sort(), ['alice', 'alice-second'])
  fs.writeFileSync(
    path.join(root, 'vms/alice-later.json'),
    JSON.stringify({ id: 'alice-later', owner_user_id: 'alice', platform: 'anthropic' }),
  )
  assert.deepEqual(
    JSON.parse(store.getById(first.id).allowed_vms).sort(),
    ['alice', 'alice-second'],
    'a later allocation does not silently widen an existing platform key',
  )
  const second = await call('POST', '/api/panel/api-keys', { name: 'other-client' })
  const other = store.getById(second.item.id)
  for (let i = 0; i < 24; i++) assert.equal(store.acquire(first).ok, true)
  assert.equal(store.canAccept(first).code, 'api_key_concurrency_limit')
  assert.equal(store.canAccept(other).code, 'user_concurrency_limit')
  store.release(first)
  assert.equal(store.acquire(other).ok, true)
  assert.equal(store.canAccept(first).code, 'user_concurrency_limit')
  store.release(other)
  for (let i = 0; i < 23; i++) store.release(first)
  assert.equal(store.canAccept(first).ok, true)
})

test('an unlimited user falls back to the configured new-key default', async (t) => {
  const { store, call } = fixture(t)
  store.db.prepare('UPDATE users SET concurrency = 0 WHERE id = ?').run('alice')
  const out = await call('POST', '/api/panel/api-keys', { name: 'fallback' })
  assert.equal(out.status, 201)
  assert.equal(out.item.max_concurrency, 12)
})

test('tenant cannot forge policy or manage another tenant key, including during body upload', async (t) => {
  const { store, call } = fixture(t)
  const key = store.create({ user_id: 'bob' })
  for (const [method, suffix] of [
    ['PATCH', ''],
    ['DELETE', ''],
    ['POST', '/rotate'],
    ['POST', '/reveal'],
    ['POST', '/reset-quota'],
    ['GET', '/stats'],
  ]) {
    assert.equal((await call(method, `/api/panel/api-keys/${key.id}${suffix}`, { name: 'stolen' })).status, 404)
  }
  const mine = store.create({ user_id: 'alice' })
  for (const body of [
    { max_concurrency: 999 },
    { user_id: 'bob' },
    { group_type: 'all' },
    { quota_usd: 0 },
    { reset_quota: true },
  ]) {
    assert.equal((await call('POST', '/api/panel/api-keys', body)).status, 403)
    assert.equal((await call('PATCH', `/api/panel/api-keys/${mine.id}`, body)).status, 403)
  }
  assert.equal((await call('POST', `/api/panel/api-keys/${mine.id}/reset-quota`, {})).status, 200)
  const raced = await call(
    'PATCH',
    `/api/panel/api-keys/${mine.id}`,
    {},
    {
      read: async () => {
        store.update(mine.id, { user_id: 'bob' })
        return { name: 'late-write' }
      },
    },
  )
  assert.equal(raced.status, 404)
  assert.notEqual(store.getById(mine.id).name, 'late-write')
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const route = method === 'POST' ? '/api/panel/api-keys' : `/api/panel/api-keys/${key.id}`
    assert.equal(
      (await call(method, route, { name: 'evil' }, { headers: { origin: 'https://evil.example' } })).status,
      403,
    )
  }
})

test('existing VM bills group by key; rotation and deletion never erase the original rows', async (t) => {
  const { store, logs, call } = fixture(t)
  const a = store.create({ user_id: 'alice' })
  const b = store.create({ user_id: 'alice' })
  for (const [id, key, cost, owner] of [
    ['r1', a.id, 2, 'alice'],
    ['r2', a.id, 3, 'alice'],
    ['r3', b.id, 7, 'alice'],
    ['old-owner', a.id, 99, 'bob'],
  ]) {
    logs.insertSummary({
      id,
      request_id: id,
      created_at: new Date().toISOString(),
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      vm_id: 'alice',
      api_key_id: key,
      user_id: owner,
      vm_owner_user_id: owner,
      input_tokens: 10,
      total_cost: cost,
      pricing_model: 'fixture',
    })
  }
  const before = store.db.prepare('SELECT * FROM usage_logs ORDER BY id').all()
  const stats = await call('GET', `/api/panel/api-keys/${a.id}/stats`)
  assert.equal(stats.status, 200)
  assert.equal(
    stats.usage_stats.history.reduce((n, day) => n + day.requests, 0),
    2,
  )
  assert.equal(
    stats.usage_stats.history.reduce((n, day) => n + day.total_cost, 0),
    5,
  )
  const second = await call('GET', `/api/panel/api-keys/${b.id}/stats`)
  assert.equal(
    second.usage_stats.history.reduce((n, day) => n + day.total_cost, 0),
    7,
  )
  const vmBill = store.db
    .prepare(
      'SELECT COUNT(*) AS requests, SUM(total_cost) AS cost FROM usage_logs WHERE vm_id = ? AND vm_owner_user_id = ?',
    )
    .get('alice', 'alice')
  assert.equal(vmBill.requests, 3)
  assert.equal(vmBill.cost, 12, 'both client keys add up to the same VM bill')
  store.recordUsage(a.id, { total_cost: 5 })
  assert.equal((await call('POST', `/api/panel/api-keys/${a.id}/reset-quota`, {})).status, 200)
  assert.equal(store.getById(a.id).quota_used, 0)
  assert.deepEqual(store.db.prepare('SELECT * FROM usage_logs ORDER BY id').all(), before)
  await call('POST', `/api/panel/api-keys/${a.id}/rotate`)
  await call('DELETE', `/api/panel/api-keys/${a.id}`)
  assert.deepEqual(store.db.prepare('SELECT * FROM usage_logs ORDER BY id').all(), before)
})

test('deleting an in-use key cannot free its user concurrency before those requests finish', async (t) => {
  const { store, call } = fixture(t)
  const a = store.create({ user_id: 'alice' })
  assert.equal(store.acquire(a).ok, true)
  assert.equal(store.acquire(a).ok, true)
  assert.equal((await call('DELETE', `/api/panel/api-keys/${a.id}`)).status, 200)
  const created = await call('POST', '/api/panel/api-keys', { name: 'new-client' })
  const b = store.getById(created.item.id)
  assert.equal(store.canAccept(b).code, 'user_concurrency_limit')
  store.release(a)
  store.release(a)
  assert.equal(store.canAccept(b).ok, true)
})
