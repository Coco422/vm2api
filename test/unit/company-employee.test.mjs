import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createEmployeeHandler } from '../../src/company/employee-api.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-api-'))
  const db = createDatabase({ dataDir: root })
  const store = new ApiKeyStore({ db, hashSecret: 'local-test' })
  for (const id of ['alice', 'bob'])
    store.users.insert({ id, username: id, role: 'user', enabled: true, password_hash: 'unused' })
  const write = (id, owner, extra = {}) => {
    fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        owner_user_id: owner,
        platform: 'anthropic',
        claude: { mode: 'oauth', scope: 'user:profile user:inference' },
        ...extra,
      }),
    )
  }
  write('mine', 'alice')
  write('other', 'bob')
  write('not-allowed', 'alice')
  const key = store.create({
    user_id: 'alice',
    group_type: 'anthropic',
    allowed_vms: ['mine', 'other'],
    name: 'alice-key',
  })
  const calls = []
  const operation = async (args) => {
    calls.push(args)
    return {
      ok: true,
      data: {
        outcome: 'reset',
        token: 'must-not-leak',
        claude_reset_credits: {
          available_count: 1,
          grant_id: 'secret',
          credits: [{ label: '本周', resets_left: 1, redeemable: true, secret: 'hidden' }],
        },
      },
    }
  }
  const handler = createEmployeeHandler({
    enabled: true,
    cfg: { paths: { project: root } },
    apiKeyStore: store,
    accountQuota: {
      snapshot: () => ({
        accounts: [
          {
            vm_id: 'mine',
            account_id: 'account-mine',
            unified: { '5h': { utilization: 0.4 }, '7d': { utilization: 0.25 } },
          },
        ],
      }),
    },
    json(res, status, body) {
      res.status = status
      res.body = body
      return true
    },
    readBody: async (req) => req.body,
    operations: Object.fromEntries(
      [
        'buildProbeOne',
        'buildOpenaiQuotaRefresh',
        'buildOpenaiQuotaReset',
        'buildClaudeResetQuery',
        'buildClaudeResetRedeem',
      ].map((name) => [name, operation]),
    ),
    usage: (_db, args) => ({ ...args }),
    ...options,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const call = async (method, url, { token = key.key, body = {}, headers = {} } = {}) => {
    const res = {
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
    }
    const req = {
      method,
      url,
      headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      socket: { remoteAddress: 'local' },
      body,
    }
    const handled = await handler(req, res, new URL(url, 'http://localhost'))
    return { ...res, handled }
  }
  return { call, store, key, calls, db, write }
}

test('company feature defaults closed and unrelated paths remain delegated', async (t) => {
  const { call } = fixture(t, { enabled: false })
  assert.equal((await call('GET', '/api/company/me')).status, 404)
  assert.equal((await call('GET', '/api/panel/me')).handled, false)
})

test('same key authenticates every request, scopes VM by key AND owner, never reveals credentials', async (t) => {
  const { call } = fixture(t)
  const res = await call('GET', '/api/company/me?user_id=bob')
  assert.equal(res.status, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.body.data.employee.name, 'alice')
  assert.deepEqual(
    res.body.data.vms.map((vm) => vm.id),
    ['mine'],
  )
  assert.equal(res.body.data.vms[0].quota.five_hour.used_percent, 40)
  assert.equal(res.body.data.vms[0].quota.seven_day.used_percent, 25)
  assert.doesNotMatch(JSON.stringify(res.body), /key_secret|account_uuid|password|scope|proxy|user:inference/)
})

test('budget exhausted can read own usage, without resetting the budget', async (t) => {
  const { call, store, key } = fixture(t)
  store.update(key.id, { quota: 1 })
  store.repo.recordUsage(key.id, { cost: 2 })
  const res = await call('GET', '/api/company/me')
  assert.equal(res.status, 200)
  assert.equal(res.body.data.key.inference_allowed, false)
  assert.equal((await call('GET', '/api/company/usage?days=7&keyId=other&userId=bob')).body.data.keyId, key.id)
  assert.equal(store.getById(key.id).quota_used, 2)
  store.repo.update({ ...store.getById(key.id), status: 'quota_exhausted' })
  assert.equal((await call('GET', '/api/company/me')).status, 200)
})

test('setting the Key amount limit to zero removes the cap without clearing recorded spend', async (t) => {
  const { call, store, key } = fixture(t)
  store.update(key.id, { quota: 1 })
  store.recordUsage(key.id, {}, { officialCost: 2 })
  assert.equal(store.getById(key.id).status, 'quota_exhausted')
  assert.equal(store.canAccept(store.getById(key.id)).ok, false)
  store.update(key.id, { quota: 0 })
  const response = await call('GET', '/api/company/me')
  assert.equal(response.status, 200)
  assert.equal(response.body.data.key.quota_usd, 0)
  assert.equal(response.body.data.key.quota_usd_used, 2)
  assert.equal(response.body.data.key.inference_allowed, true)
  assert.equal(store.getById(key.id).status, 'active')
})

test('revocation, rotation, expiry and disabled employee take effect immediately', async (t) => {
  const { call, store, key } = fixture(t)
  store.update(key.id, { status: 'disabled' })
  assert.equal((await call('GET', '/api/company/me')).status, 403)
  store.update(key.id, { status: 'active', expires_at: '2020-01-01T00:00:00Z' })
  assert.equal((await call('GET', '/api/company/me')).status, 403)
  store.update(key.id, { expires_at: null })
  const next = store.rotate(key.id)
  assert.equal((await call('GET', '/api/company/me')).status, 401)
  assert.equal((await call('GET', '/api/company/me', { token: next.key })).status, 200)
  store.users.update({ ...store.users.getById('alice'), enabled: false })
  assert.equal((await call('GET', '/api/company/me', { token: next.key })).status, 401)
})

test('master, panel session, unowned, API category and privileged owners cannot enter', async (t) => {
  const { call, store, key } = fixture(t)
  for (const token of ['master-key', 'kin-panel-test', '', store.create({}).key])
    assert.ok((await call('GET', '/api/company/me', { token })).status >= 400)
  store.users.update({ ...store.users.getById('alice'), role: 'admin' })
  assert.equal((await call('GET', '/api/company/me')).status, 403)
  store.users.update({ ...store.users.getById('alice'), role: 'user' })
  store.update(key.id, { category: 'api' })
  assert.equal((await call('GET', '/api/company/me')).status, 403)
})

test('foreign and missing VMs respond identically; no privileged operation runs', async (t) => {
  const { call, calls } = fixture(t)
  for (const id of ['other', 'not-allowed', 'missing'])
    assert.equal((await call('POST', `/api/company/vms/${id}/reset-query`)).status, 404)
  assert.equal(calls.length, 0)
})

test('only usage queries and allowed actions exist; writes cannot smuggle config', async (t) => {
  const { call, calls } = fixture(t)
  for (const action of ['reset', 'cooldown/clear', 'schedulable', 'oauth/credential', 'start'])
    assert.equal((await call('POST', `/api/company/vms/mine/${action}`)).status, 404)
  assert.equal((await call('PATCH', '/api/company/vms/mine')).status, 404)
  assert.equal(
    (await call('POST', '/api/company/vms/mine/reset-query', { body: { max_concurrency: 100 } })).status,
    400,
  )
  assert.equal(
    (await call('POST', '/api/company/vms/mine/reset-query', { headers: { origin: 'https://evil.invalid' } })).status,
    403,
  )
  assert.equal(
    (await call('POST', '/api/company/vms/mine/reset-query', { headers: { 'content-type': 'text/plain' } })).status,
    415,
  )
  assert.equal((await call('GET', '/api/company/usage?days=999')).status, 400)
  assert.equal(calls.length, 0)
})

test('reset preserves idempotency header, projects a safe response, scopes args', async (t) => {
  const { call, calls } = fixture(t)
  assert.equal((await call('POST', '/api/company/vms/mine/reset-redeem')).status, 400)
  const res = await call('POST', '/api/company/vms/mine/reset-redeem', {
    headers: { 'idempotency-key': 'local-operation-1' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.outcome, 'reset')
  assert.equal(res.body.data.reset_credits.available_count, 1)
  assert.doesNotMatch(JSON.stringify(res.body), /must-not-leak|grant_id|hidden/)
  assert.equal(calls[0].id, 'mine')
  assert.equal(calls[0].idempotencyKey, 'local-operation-1')
})

test('unknown quota remains null, unassigned key never sees the global pool', async (t) => {
  const { call, write, store, key } = fixture(t)
  write('mine', 'bob')
  assert.deepEqual((await call('GET', '/api/company/me')).body.data.vms, [])
  write('mine', 'alice', { account_uuid: 'new-account' })
  store.update(key.id, { allowed_vms: ['not-allowed'] })
  const res = await call('GET', '/api/company/me')
  assert.equal(res.body.data.vms[0].quota.five_hour.used_percent, null)
})

test('restore maintenance blocks company mutations and reads', async (t) => {
  const { call, calls } = fixture(t, { isRestoring: () => true })
  assert.equal((await call('GET', '/api/company/me')).status, 503)
  assert.equal((await call('POST', '/api/company/vms/mine/reset-query')).status, 503)
  assert.equal(calls.length, 0)
})

test('revocation while an operation body is arriving cannot reach the upstream', async (t) => {
  let revoke
  const { call, store, key, calls } = fixture(t, {
    readBody: async () => {
      revoke()
      return {}
    },
  })
  revoke = () => store.update(key.id, { status: 'disabled' })
  assert.equal((await call('POST', '/api/company/vms/mine/reset-query')).status, 403)
  assert.equal(calls.length, 0)
})

test('overlapping operations on one VM are rejected, and errors do not reveal upstream payloads', async (t) => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const { call } = fixture(t, {
    operations: {
      buildClaudeResetQuery: async () => {
        await pending
        throw new Error('secret-token-and-proxy')
      },
    },
  })
  const first = call('POST', '/api/company/vms/mine/reset-query')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await call('POST', '/api/company/vms/mine/reset-query')).status, 409)
  release()
  const response = await first
  assert.equal(response.status, 502)
  assert.doesNotMatch(JSON.stringify(response), /secret-token-and-proxy/)
})

test('OpenAI VM uses its own cached quota fields, and an unknown window stays unknown', async (t) => {
  const { call, store, key, write } = fixture(t)
  write('gpt', 'alice', {
    platform: 'openai',
    family: 'codex',
    codex: { has_access: true, extra: { codex_5h_used_percent: 63, codex_5h_window_minutes: 300 } },
  })
  store.update(key.id, { group_type: 'openai', allowed_vms: ['gpt'] })
  const result = await call('GET', '/api/company/me')
  assert.equal(result.body.data.vms[0].quota.five_hour.used_percent, 63)
  assert.equal(result.body.data.vms[0].quota.seven_day.used_percent, null)
})

test('daily request route always uses the authenticated key and caller, and validates query parameters', async (t) => {
  const { call, db, key } = fixture(t)
  const logs = new UsageLogsRepo(db)
  for (const [id, owner, keyId] of [
    ['mine', 'alice', key.id],
    ['other-owner', 'bob', key.id],
    ['other-key', 'alice', 'key-other'],
  ]) {
    logs.insertSummary({
      id,
      request_id: id,
      created_at: '2024-02-29T03:00:00.000Z',
      user_id: owner,
      api_key_id: keyId,
      status: 200,
      total_cost: 1,
    })
  }
  const response = await call('GET', '/api/company/requests?day=2024-02-29&userId=bob&keyId=other')
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.body.data.items.map((item) => item.request_id),
    ['mine'],
  )
  for (const query of [
    'day=2024-02-30',
    'day=2024-02-29&page=0',
    'day=2024-02-29&page_size=101',
    'day=2024-02-29&page=1.5',
    '',
  ]) {
    assert.equal((await call('GET', `/api/company/requests?${query}`)).status, 400)
  }
})
