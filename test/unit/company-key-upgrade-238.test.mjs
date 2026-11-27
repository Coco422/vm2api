import '../fixtures/kin-computer-test-env.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { keyScopeFromRequest, resolvePoolAccessForKey } from '../../src/lib/admin/key-scope.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ownerScopeFromRequest } from '../../src/lib/admin/resource-owner.mjs'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { projectCandidateAccounts } from '../../src/lib/protocol/unified-pre-dispatch.mjs'

const migrations = fileURLToPath(new URL('../../src/lib/db/migrations/', import.meta.url))
const legacyToken = (id) => 'fixture-offline-legacy-' + id

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-key-upgrade-'))
  const oldDir = path.join(root, '067')
  fs.mkdirSync(oldDir)
  for (const f of fs.readdirSync(migrations).filter((f) => /^\d+.*\.sql$/.test(f) && f < '068')) {
    fs.copyFileSync(path.join(migrations, f), path.join(oldDir, f))
  }
  const db = createDatabase({ dbPath: path.join(root, 'kin.db'), migrationsDir: oldDir })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const users = new UsersRepo(db)
  for (const [id, role] of [
    ['alice', 'user'],
    ['bob', 'user'],
    ['ops', 'admin'],
  ]) {
    users.insert({ id, username: id, password_hash: 'fixture-only', role, enabled: true, concurrency: 12 })
  }
  const insert = db.prepare(
    'INSERT INTO api_keys (id, name, key, user_id, group_type, allowed_vms, max_concurrency) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const [id, owner, group, pins] of [
    ['alice-all', 'alice', 'all', ['vm-a1']],
    ['alice-legacy-empty', 'alice', 'all', []],
    ['alice-openai', 'alice', 'openai', ['vm-a1']],
    ['ops', 'ops', 'all', []],
  ])
    insert.run(id, id, legacyToken(id), owner, group, JSON.stringify(pins), 12)
  assert.deepEqual(
    applyMigrations(db).map((f) => f.slice(0, 3)),
    ['068', '069', '070', '071'],
  )
  assert.deepEqual(applyMigrations(db), [])
  const store = new ApiKeyStore({ db })
  function vm(id, owner, platform = 'openai') {
    const dir = path.join(root, 'vms', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', id + '.json'),
      JSON.stringify({
        id,
        owner_user_id: owner,
        platform,
        schedulable: true,
        status: 'running',
        has_token: true,
      }),
    )
    if (platform === 'openai') {
      fs.writeFileSync(
        path.join(dir, 'codex-credentials.json'),
        JSON.stringify({
          accounts: [
            { id: id + '-account', access_token: 'fixture', refresh_token: 'fixture', chatgpt_account_id: id },
          ],
        }),
      )
    }
  }
  vm('vm-a1', 'alice')
  vm('vm-b1', 'bob')
  vm('vm-p1', null)
  vm('vm-p2', null)
  function scopes(token) {
    const auth = store.authenticate(token)
    assert.equal(auth.ok, true)
    const req = { headers: {}, apiKeyKind: 'managed', apiKeyRecord: auth.record }
    return { req, ownerScope: ownerScopeFromRequest(req, users), keyScope: keyScopeFromRequest(req) }
  }
  function candidates(token, options = {}) {
    const { req, ownerScope, keyScope } = scopes(token)
    return pickCodexCandidates(root, req, { ownerScope, keyScope, ...options }).ids.sort()
  }
  function projected(token) {
    const { keyScope, ownerScope } = scopes(token)
    return projectCandidateAccounts({ projectRoot: root, keyScope, ownerScope })
      .map((v) => v.id)
      .sort()
  }
  async function panel(user, method, route, body) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      apiKeyStore: store,
      routingConfig: { concurrency: { default_key_concurrency: 12 } },
      requireAuth(req) {
        Object.assign(req, { panelUser: user, panelUserId: user, panelRole: users.getById(user).role })
        return true
      },
      readBody: async () => body,
      json(_res, status, value) {
        response = { status, ...value }
        return true
      },
    })
    await handler(
      { method, headers: { host: 'localhost', 'content-type': 'application/json' } },
      {},
      new URL(route, 'http://localhost'),
    )
    return response
  }
  async function create(user, body) {
    const result = await panel(user, 'POST', '/api/panel/api-keys', body)
    assert.equal(result.status, 201, JSON.stringify(result.error))
    return result.item
  }
  return { root, db, store, vm, scopes, candidates, projected, panel, create }
}

test('067 tenant pins apply after upgrade, capacity expansion, sticky continuation and transfer', (t) => {
  const { vm, candidates } = fixture(t)
  const sticky = {
    body: { previous_response_id: 'synthetic-response' },
    stickyRouter: { extractPoolKey: () => 'synthetic-session', resolve: () => ({ vmId: 'vm-a1' }) },
  }
  for (const id of ['alice-all', 'alice-openai']) {
    assert.deepEqual(candidates(legacyToken(id)), ['vm-a1'])
  }
  vm('vm-a2', 'alice')
  for (const id of ['alice-all', 'alice-openai']) {
    assert.deepEqual(candidates(legacyToken(id)), ['vm-a1'], id)
    assert.deepEqual(candidates(legacyToken(id), { excluded: new Set(['vm-a1']) }), [], id)
  }
  vm('vm-a1', 'bob')
  for (const id of ['alice-all', 'alice-openai']) {
    assert.deepEqual(candidates(legacyToken(id), sticky), [], id)
    assert.deepEqual(candidates(legacyToken(id)), [], id)
  }
})

test('067 unpinned tenant keys retain their original owner-wide grant without rewriting its shape', (t) => {
  const f = fixture(t)
  const token = legacyToken('alice-legacy-empty')
  assert.deepEqual(f.candidates(token), ['vm-a1'])
  f.vm('vm-a2', 'alice')
  assert.deepEqual(f.candidates(token), ['vm-a1', 'vm-a2'])
  f.vm('vm-a1', 'bob')
  assert.deepEqual(f.candidates(token), ['vm-a2'])
  assert.deepEqual(JSON.parse(f.store.getById('alice-legacy-empty').allowed_vms), [])
})

test('067 managed administrator and new resource keys stay in platform domain and respect VM pins', async (t) => {
  const f = fixture(t)
  assert.deepEqual(f.candidates(legacyToken('ops')), ['vm-p1', 'vm-p2'])
  const pinned = await f.create('ops', {
    name: 'one',
    permission_tier: 'resource',
    group_type: 'all',
    allowed_vms: ['vm-p1'],
  })
  assert.deepEqual(f.candidates(pinned.key), ['vm-p1'])
  const denied = await f.panel('ops', 'POST', '/api/panel/api-keys', {
    name: 'cross-domain',
    permission_tier: 'resource',
    group_type: 'all',
    allowed_vms: ['vm-b1'],
  })
  assert.equal(denied.status, 403)
})

test('administrator cannot choose another tenant ownership domain on create or update', async (t) => {
  const f = fixture(t)
  const mine = await f.create('ops', { name: 'mine' })
  for (const [method, route] of [
    ['POST', '/api/panel/api-keys'],
    ['PATCH', '/api/panel/api-keys/' + mine.id],
  ]) {
    const out = await f.panel('ops', method, route, { name: 'delegated', permission_tier: 'tenant', owner_id: 'bob' })
    assert.equal(out.status, 403, method)
  }
})

test('mixed-platform tenant keys snapshot resources and capacity independently on each issue', async (t) => {
  const f = fixture(t)
  f.vm('vm-claude', 'alice', 'anthropic')
  const first = await f.create('alice', { name: 'old' })
  assert.deepEqual(f.projected(first.key), ['vm-a1', 'vm-claude'])
  f.vm('vm-a2', 'alice')
  f.db.prepare('UPDATE users SET concurrency=24 WHERE id=?').run('alice')
  const second = await f.create('alice', { name: 'new' })
  assert.equal(f.store.getById(first.id).max_concurrency, 12)
  assert.equal(f.store.getById(second.id).max_concurrency, 24)
  assert.deepEqual(f.projected(first.key), ['vm-a1', 'vm-claude'])
  assert.deepEqual(f.projected(second.key), ['vm-a1', 'vm-a2', 'vm-claude'])
})

test('endpoint-only and Gemini-only resource keys cannot acquire any OAuth VM', (t) => {
  const f = fixture(t)
  for (const grant of [{ allowed_endpoints: ['synthetic-endpoint'] }, { allowed_gemini_envs: ['synthetic-env'] }]) {
    const item = f.store.create({
      name: 'external-only',
      user_id: 'ops',
      category: 'all',
      permission_tier: 'resource',
      group_type: 'all',
      allowed_vms: [],
      ...grant,
    })
    assert.deepEqual(f.candidates(item.key), [])
  }
})

test('071 default and trusted downgrade pools intersect the original VM grant and current owner', (t) => {
  const f = fixture(t)
  f.vm('vm-a2', 'alice')
  const repo = new SchedulerPoolsRepo(f.db)
  const main = repo.insert({ name: 'primary', provider_scope: 'openai' })
  const backup = repo.insert({ name: 'backup', provider_scope: 'openai', pool_role: 'downgrade' })
  const ids = ['vm-a1', 'vm-a2', 'vm-b1', 'vm-p1']
  for (const pool of [main, backup]) {
    repo.setMembers(
      pool.id,
      ids.map((node_id) => ({ node_id, node_type: 'codex_vm' })),
    )
  }
  repo.setKeyBindings('alice-all', [main.id], { defaultPoolId: main.id, bindingMode: 'strict_pool' })
  const { req, ownerScope } = f.scopes(legacyToken('alice-all'))
  function resolve(options = {}) {
    return resolvePoolAccessForKey({
      key: req.apiKeyRecord,
      apiKeyKind: 'managed',
      ownerScope,
      poolsRepo: repo,
      vms: listVms(f.root),
      model: 'gpt-6',
      ...options,
    })
  }
  assert.equal(resolve({ requestedPoolId: backup.id }).status, 403)
  for (const options of [{}, { jevDowngradePoolId: backup.id, isTrustedDowngrade: true }]) {
    assert.deepEqual(resolve(options).allowedVmIds, ['vm-a1'])
  }
  f.vm('vm-a1', 'bob')
  assert.equal(resolve().status, 403)
  assert.equal(resolve({ jevDowngradePoolId: backup.id, isTrustedDowngrade: true }).status, 403)
})

test('pool management cannot rewrite a different key owner’s frozen grant', async (t) => {
  const f = fixture(t)
  const repo = new SchedulerPoolsRepo(f.db)
  const legacy = await f.panel('ops', 'POST', '/api/panel/vm-pools', { name: 'restricted', vm_ids: ['vm-p1'] })
  assert.equal(legacy.status, 201)
  const pool = legacy.data.pool
  const foreign = await f.create('alice', { name: 'tenant-client' })
  const keyRoute = '/api/panel/pools/' + pool.id + '/keys'
  const before = f.store.getById(foreign.id)
  const denied = await f.panel('ops', 'POST', keyRoute, { api_key_id: foreign.id, pool_binding_mode: 'strict_pool' })
  assert.ok([403, 404].includes(denied.status), 'pool binding must reject a different owner')
  assert.deepEqual(f.store.getById(foreign.id), before)
  repo.setKeyBindings(foreign.id, [pool.id], { defaultPoolId: pool.id, bindingMode: 'strict_pool' })
  const listing = await f.panel('ops', 'GET', keyRoute)
  assert.equal(listing.status, 200)
  assert.ok(!listing.data.keys.some((item) => [item.id, item.api_key_id].includes(foreign.id)))
  const unlink = await f.panel('ops', 'DELETE', keyRoute + '/' + foreign.id)
  assert.ok([403, 404].includes(unlink.status))
  assert.deepEqual(
    repo.listBindingsByKey(foreign.id).map((b) => b.pool_id),
    [pool.id],
  )
  const remove = await f.panel('ops', 'DELETE', '/api/panel/pools/' + pool.id + '?force=1')
  assert.ok([403, 409].includes(remove.status))
  assert.deepEqual(
    repo.listBindingsByKey(foreign.id).map((b) => b.pool_id),
    [pool.id],
  )
  const legacyRemove = await f.panel('ops', 'DELETE', '/api/panel/vm-pools/' + pool.id)
  assert.ok([403, 409].includes(legacyRemove.status))
  assert.deepEqual(
    repo.listBindingsByKey(foreign.id).map((b) => b.pool_id),
    [pool.id],
  )
})
