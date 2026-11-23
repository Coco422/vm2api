import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Panel sessions persist under KIN_DATA_DIR at module load; keep them in an owned temp dir.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-data-'))
const previousDataDir = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = dataDir
after(() => {
  if (previousDataDir == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
const { createRoutingRuntime } = await import('../../src/lib/admin/routing-runtime.mjs')
const { authorizePanelRoute } = await import('../../src/lib/admin/panel-acl.mjs')
const { ApiKeyStore } = await import('../../src/lib/admin/api-keys.mjs')
const { PanelUserStore } = await import('../../src/lib/admin/panel-users.mjs')
const { parseAllowedVms } = await import('../../src/lib/admin/key-scope.mjs')
const { parseKeyAllowedModels } = await import('../../src/lib/admin/key-models.mjs')
const { createVmPool } = await import('../../src/lib/admin/vm-pools.mjs')
const { VmPoolsRepo } = await import('../../src/lib/db/repos/vm-pools-repo.mjs')
const { createDatabase, openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
const { prepareVmDelivery, recordDeliveryShutdown } = await import('../../src/company/vm-delivery-statistics.mjs')
const { SettingsRepo } = await import('../../src/lib/db/repos/settings-repo.mjs')
const { createPanelSession, verifyPanelSession } = await import('../../src/lib/core/security.mjs')
const { readCodexAccounts, upsertCodexAccount } = await import('../../src/lib/vm/codex-slot.mjs')
const { isVmScheduleReady } = await import('../../src/lib/vm/vm-registry.mjs')
const { isCodexSlotReady } = await import('../../src/lib/pool/codex-slot-pool.mjs')
const { AccountQuota } = await import('../../src/lib/pool/account-quota.mjs')

const TENANT = { panelUser: 'tenant', panelRole: 'user', panelUserId: 'u-1' }
const ADMIN = { panelUser: 'boss', panelRole: 'admin', panelUserId: 'u-1' }

test('VM batch counts are global, while each lifecycle follows existing VM ownership', async (t) => {
  const root = makeProject(t)
  const db = openDatabase({ dataDir })
  t.after(closeDatabase)
  writeVm(root, { id: 'vm-03', status: 'stopped', owner_user_id: 'u-1', created_at: '2026-10-29T17:56:01Z' })
  writeVm(root, { id: 'vm-2-13', status: 'stopped', owner_user_id: 'u-2' })
  const extra = { accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) } }
  const tenant = makeHandler(root, TENANT, null, extra)
  const admin = makeHandler(root, ADMIN, null, extra)
  const batchPath = '/api/panel/statistics/vm-batches'
  const initial = (await tenant.call('GET', batchPath + '?vm_id=vm-2-13')).body.data
  assert.deepEqual(initial.map(({ batch, started, active, stopped }) => [batch, started, active, stopped]), [
    ['第一批', 11, 8, 3],
    ['第二批', 10, 9, 1],
    ['第三批', 12, 11, 1],
    ['补机（11 月 20 日）', 1, 1, 0],
  ])
  const vm06Days = (Date.parse('2026-11-18T04:15:17.684Z') - Date.parse('2026-11-01T09:10:37.555Z')) / 86_400_000
  assert.equal(initial[0].medianSurvivalDays, vm06Days)
  for (const row of initial)
    assert.deepEqual(Object.keys(row).sort(), ['active', 'batch', 'medianSurvivalDays', 'started', 'stopped'])
  assert.equal((await tenant.call('POST', batchPath)).status, 403)
  assert.equal((await tenant.call('GET', '/api/panel/vms/vm-2-13?visibility=global')).status, 404)
  assert.equal((await admin.call('GET', '/api/panel/vms/vm-2-13')).body.data.delivery_lifecycle.batch, '第二批')

  const vm = { id: 'vm-03', status: 'stopped', schedule_updated_at: '2026-11-01T08:16:14.894Z' }
  recordDeliveryShutdown({ ...vm, schedule_off_reason: 'tenant_paused' }, () => db)
  recordDeliveryShutdown({ ...vm, schedule_off_reason: 'stopped', created_at: '2026-11-01' }, () => db)
  assert.equal((await tenant.call('GET', batchPath)).body.data[0].stopped, 3)

  recordDeliveryShutdown({ ...vm, schedule_off_reason: 'stopped' }, () => db)
  recordDeliveryShutdown({ ...vm, schedule_off_reason: 'stopped', schedule_updated_at: '2026-11-02' }, () => db)
  const detail = (await tenant.call('GET', '/api/panel/vms/vm-03')).body.data.delivery_lifecycle
  assert.equal(detail.shutdownAt, vm.schedule_updated_at)
  assert.equal(detail.survivalDays, 1)
  const first = (await tenant.call('GET', batchPath)).body.data[0]
  assert.equal(first.stopped, 4)
  assert.equal(first.active, 7)
  assert.equal(first.medianSurvivalDays, (1 + vm06Days) / 2)

  const future = { id: 'vm-fourth', owner_user_id: 'u-1', status: 'running', created_at: '2026-11-20T00:00:00.000Z' }
  writeVm(root, future)
  const panelUsers = new PanelUserStore({ db })
  const recipient = panelUsers.create({ username: 'recipient', password: 'recipient-pass-1', role: 'user' })
  const delivery = { user_id: recipient.id, delivery_batch: '第四批' }
  const ownerPath = '/api/panel/vms/vm-fourth/owner'
  assert.equal((await makeHandler(root, TENANT, delivery, { panelUsers }).call('PATCH', ownerPath)).status, 403)
  assert.equal((await makeHandler(root, ADMIN, delivery, { panelUsers }).call('PATCH', ownerPath)).status, 200)
  assert.equal(prepareVmDelivery(future, '别的批次', db).status, 409)
  const readFourth = async () => (await tenant.call('GET', batchPath)).body.data.find(({ batch }) => batch === '第四批')
  assert.equal((await readFourth()).started, 0)
  const insert = db.prepare('INSERT INTO usage_logs (id, request_id, vm_id, status, final_state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run('earlier', 'earlier', future.id, 200, 'verified', '2026-11-18T00:00:00.000Z')
  insert.run('failure', 'failure', future.id, 401, 'verified', '2026-11-20T01:00:00.000Z')
  insert.run('partial', 'partial', future.id, 200, 'failed', '2026-11-20T02:00:00.000Z')
  assert.equal((await readFourth()).started, 0)
  insert.run('success', 'success', future.id, 200, 'verified', '2026-11-20T03:00:00.000Z')
  assert.equal((await readFourth()).active, 1)
  const at = '2026-11-20T15:00:00.000Z'
  recordDeliveryShutdown({ ...future, status: 'stopped', schedule_off_reason: 'tenant_paused', schedule_updated_at: at }, () => db)
  assert.equal((await readFourth()).stopped, 0)
  recordDeliveryShutdown({ ...future, status: 'stopped', schedule_off_reason: 'stopped', schedule_updated_at: at }, () => db)
  fs.unlinkSync(path.join(root, 'vms', future.id + '.json'))
  assert.deepEqual(await readFourth(), { batch: '第四批', started: 1, active: 0, stopped: 1, medianSurvivalDays: 0.5 })
})

test('tenant VM JSON hides purchased proxy metadata and operator labels; admin keeps them', async (t) => {
  const root = makeProject(t)
  const original = {
    id: 'vm-private-exit',
    name: 'US · private-supplier-07',
    note: 'Bought from private-supplier',
    status: 'stopped',
    owner_user_id: 'u-1',
    claude: {},
    proxy: {
      id: 'px-private-supplier',
      host: 'private-supplier.example',
      port: 10007,
      username: 'private-proxy-user',
      password: 'private-proxy-password',
      url: 'socks5://private-proxy-user:private-proxy-password@private-supplier.example:10007',
    },
  }
  writeVm(root, original)
  const extra = { accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) } }
  for (const url of ['/api/panel/vms', '/api/panel/vms/vm-private-exit']) {
    const tenant = await makeHandler(root, TENANT, null, extra).call('GET', url)
    assert.equal(tenant.status, 200)
    const vm = tenant.body.data.items?.[0] || tenant.body.data.vm
    assert.equal(vm.name, original.id)
    assert.equal(vm.note, null)
    assert.equal(vm.proxy_id, null)
    assert.equal(vm.proxy_configured, true)
    assert.equal(vm.proxy.label, '独享代理')
    assert.equal(vm.proxy.host, undefined)
    assert.equal(tenant.body.data.proxy_pool, null)
    assert.doesNotMatch(JSON.stringify(tenant.body), /private-supplier|private-proxy-user|private-proxy-password|10007/)

    const admin = await makeHandler(root, ADMIN, null, extra).call('GET', url)
    assert.equal(admin.status, 200)
    const full = admin.body.data.items?.[0] || admin.body.data.vm
    assert.equal(full.name, original.name)
    assert.equal(full.proxy.host, original.proxy.host)
    assert.equal(full.proxy.port, original.proxy.port)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'vms', original.id + '.json'))).proxy, original.proxy)
})

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return root
}

function writeVm(root, vm) {
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
}

function codexVm(root, id, owner) {
  writeVm(root, {
    id,
    platform: 'openai',
    family: 'codex',
    owner_user_id: owner,
    codex: { email: `${id}@example.com`, has_access: true, has_refresh: true },
  })
  upsertCodexAccount(root, id, { email: `${id}@example.com`, access_token: `old-${id}`, refresh_token: 'rt' })
}

function claudeVm(root, id, owner) {
  writeVm(root, { id, platform: 'anthropic', family: 'claude', owner_user_id: owner })
}

function makeHandler(root, who, body, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    ...extra,
    requireAuth(req) {
      Object.assign(req, who)
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => (typeof body === 'function' ? body() : body),
  })
  const call = (method, url, headers = { host: 'localhost', 'content-type': 'application/json' }) =>
    handlePanel({ method, headers }, { setHeader() {} }, new URL(`http://localhost${url}`)).then(() => response)
  return { call, response }
}

test('tenant management requests are rejected before any VM or credential mutation', async (t) => {
  const root = makeProject(t)
  codexVm(root, 'vm-mine', 'u-1')
  codexVm(root, 'vm-other', 'u-2')
  const before = readCodexAccounts(root, 'vm-mine')
  for (const id of ['vm-mine', 'vm-other', 'vm-nope']) {
    for (const [method, suffix] of [
      ['POST', 'start'],
      ['POST', 'stop'],
      ['POST', 'recover'],
      ['PATCH', ''],
      ['DELETE', ''],
      ['GET', 'package'],
      ['GET', 'oauth/credential'],
      ['PUT', 'oauth/credential'],
    ]) {
      const response = await makeHandler(root, TENANT, { max_concurrency: 999, raw: 'new' }).call(
        method,
        `/api/panel/vms/${id}${suffix ? '/' + suffix : ''}`,
      )
      assert.equal(response.status, 403, `${method} ${id}/${suffix}`)
    }
  }
  const imported = await makeHandler(root, TENANT, { vm_id: 'vm-mine', mode: 'access_token', raw: 'new' }).call(
    'POST',
    '/api/panel/vms/import',
  )
  assert.equal(imported.status, 403)
  assert.deepEqual(readCodexAccounts(root, 'vm-mine'), before)
  // Allowed credit actions still pass through ownership checks, hiding foreign/missing slots.
  for (const action of [
    'openai-quota/refresh',
    'openai-quota/reset',
    'claude-reset/query',
    'claude-reset/redeem',
    'test-chat',
    'count-tokens',
  ]) {
    const foreign = await makeHandler(root, TENANT, {}).call('POST', `/api/panel/vms/vm-other/${action}`)
    const missing = await makeHandler(root, TENANT, {}).call('POST', `/api/panel/vms/vm-nope/${action}`)
    assert.equal(foreign.status, 404)
    assert.deepEqual(foreign.body, missing.body)
  }
})

test('admin import still reaches any slot', async (t) => {
  const root = makeProject(t)
  codexVm(root, 'vm-other', 'u-2')
  const out = await makeHandler(root, ADMIN, { vm_id: 'vm-other', mode: 'access_token', raw: 'admin-at' }).call(
    'POST',
    '/api/panel/vms/import',
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(readCodexAccounts(root, 'vm-other')[0].access_token, 'admin-at')
})

test('tenants can enable and update only their own Claude quota gates', async (t) => {
  const root = makeProject(t)
  const original = {
    id: 'vm-mine',
    owner_user_id: 'u-1',
    platform: 'anthropic',
    status: 'running',
    schedulable: true,
    policy: {
      maxConcurrency: 12,
      quota: { limit_5h: 0.85, limit_7d: 0.8, block_on_5h: false, weekly_split: true },
    },
  }
  writeVm(root, original)
  claudeVm(root, 'vm-other', 'u-2')
  claudeVm(root, 'vm-platform', null)
  codexVm(root, 'vm-gpt', 'u-1')
  const live = new Map()
  const { applyVmQuotaOverride } = createRoutingRuntime({
    cfg: { paths: { project: root } },
    accountQuota: { setVmQuotaOverride: (id, quota) => live.set(id, quota) },
  })
  const patch = (body, id = original.id, headers) =>
    makeHandler(root, TENANT, body, { applyVmQuotaOverride }).call(
      'PATCH',
      `/api/panel/vms/${id}/quota-thresholds`,
      headers,
    )
  const read = (id = original.id) => JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`)))
  for (const body of [
    null,
    {},
    [],
    { limit_5h: '0.95' },
    { limit_5h: 0.29 },
    { limit_7d: 1.01 },
    { limit_5h: 0.9, limit_7d: 0 },
    { limit_5h: 0.9, block_on_5h: false },
    { block_on_7d: null },
    { block_on_7d: 'true' },
    { tenant_exact_7d: true },
    { weekly_split: null },
    { max_concurrency: 256 },
  ]) {
    assert.equal((await patch(body)).status, 400, JSON.stringify(body))
  }
  for (const id of ['vm-other', 'vm-platform', 'vm-missing']) {
    assert.equal((await patch({ block_on_5h: true }, id)).status, 404)
  }
  assert.equal((await patch({ block_on_5h: true }, 'vm-gpt')).status, 400)
  const denied = await patch({ limit_5h: 0.9 }, original.id, {
    host: 'localhost',
    origin: 'https://example.com',
    'content-type': 'application/json',
  })
  assert.equal(denied.status, 403)
  assert.equal((await patch({ limit_5h: 0.9 }, original.id, { host: 'localhost' })).status, 415)
  assert.deepEqual(read(), original)
  assert.equal(live.size, 0)

  assert.equal((await patch({ block_on_5h: true })).status, 200)
  const enabled5 = { ...original.policy.quota, block_on_5h: true, tenant_exact_5h: true }
  assert.deepEqual(live.get(original.id), enabled5)
  assert.deepEqual(read().policy.quota, enabled5)
  const results = await Promise.all([patch({ limit_5h: 0.3 }), patch({ limit_7d: 1 })])
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  )
  const both = { ...enabled5, limit_5h: 0.3, limit_7d: 1, block_on_7d: true, tenant_exact_7d: true }
  assert.deepEqual(read().policy, { ...original.policy, quota: both })
  assert.deepEqual(live.get(original.id), both)
  assert.equal((await patch({ limit_7d: null })).status, 200)
  const { limit_7d: _week, limit_5h: _hour, ...switches } = both
  assert.deepEqual(read().policy.quota, { ...switches, limit_5h: 0.3 })
  assert.equal((await patch({ limit_5h: null })).status, 200)
  const after = read()
  assert.deepEqual(after.policy, { ...original.policy, quota: switches })
  assert.deepEqual(live.get(original.id), after.policy.quota)
  assert.equal(after.schedulable, true)
  assert.equal(after.status, 'running')
})

test('tenant proxy import cannot bind a slot it does not own', async (t) => {
  const root = makeProject(t)
  claudeVm(root, 'vm-other', 'u-2')
  const calls = []
  const proxyPool = {
    importLines(...args) {
      calls.push(['import', ...args])
      return { items: [{ id: 'px-1' }] }
    },
    bind(...args) {
      calls.push(['bind', ...args])
      return { ok: false, error: 'stub' }
    },
  }
  const tenant = await makeHandler(root, TENANT, { text: 'h:1080', bind_vm_id: 'vm-other' }, { proxyPool }).call(
    'POST',
    '/api/panel/proxies/import',
  )
  assert.equal(tenant.status, 403)
  assert.deepEqual(calls, [])

  const admin = await makeHandler(root, ADMIN, { text: 'h:1080', bind_vm_id: 'vm-other' }, { proxyPool }).call(
    'POST',
    '/api/panel/proxies/import',
  )
  assert.equal(admin.status, 200, JSON.stringify(admin.body))
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['import', 'bind'],
  )
})

function keyFixture(t) {
  const root = makeProject(t)
  claudeVm(root, 'vm-mine', 'u-1')
  claudeVm(root, 'vm-other', 'u-2')
  const store = new ApiKeyStore({ dataDir: fs.mkdtempSync(path.join(root, 'keys-')) })
  const key = store.create({ name: 'mine', user_id: 'u-1', group_id: 1 })
  return { root, store, key }
}

test('tenant cannot change concurrency, limits or ownership; own key reveal remains scoped', async (t) => {
  const { root, store, key } = keyFixture(t)
  const other = store.create({ name: 'other', user_id: 'u-2', group_id: 1 })
  const before = structuredClone(store.getById(key.id))
  const count = store.list().length
  for (const body of [
    { max_concurrency: 999 },
    { quota: 0, rpm: 0, rate_limit_5h: 0 },
    { user_id: 'u-2', group_id: 7 },
    { group_type: 'all', allowed_vms: [] },
    { vm_pool_id: null },
  ]) {
    const out = await makeHandler(root, TENANT, body, { apiKeyStore: store }).call(
      'PATCH',
      `/api/panel/api-keys/${key.id}`,
    )
    assert.equal(out.status, 403)
  }
  for (const [method, url] of [
    ['POST', '/api/panel/api-keys'],
    ['POST', `/api/panel/api-keys/${key.id}/reset-quota`],
  ]) {
    const out = await makeHandler(root, TENANT, { max_concurrency: 999 }, { apiKeyStore: store }).call(method, url)
    assert.equal(out.status, 403)
  }
  assert.deepEqual(store.getById(key.id), before)
  assert.equal(store.list().length, count)
  const mine = await makeHandler(root, TENANT, null, { apiKeyStore: store }).call(
    'POST',
    `/api/panel/api-keys/${key.id}/reveal`,
  )
  assert.equal(mine.status, 200)
  const foreign = await makeHandler(root, TENANT, null, { apiKeyStore: store }).call(
    'POST',
    `/api/panel/api-keys/${other.id}/reveal`,
  )
  const missing = await makeHandler(root, TENANT, null, { apiKeyStore: store }).call(
    'POST',
    '/api/panel/api-keys/key-nope/reveal',
  )
  assert.equal(foreign.status, 404)
  assert.deepEqual(foreign.body, missing.body)
})

test('tenant cannot delete a self-created slot; admin still can', async (t) => {
  const root = makeProject(t)
  writeVm(root, {
    id: 'vm-mine',
    platform: 'anthropic',
    family: 'claude',
    owner_user_id: 'u-1',
    origin: 'user_created',
  })
  const tenantDel = await makeHandler(root, TENANT, {}, {}).call('DELETE', '/api/panel/vms/vm-mine')
  assert.equal(tenantDel.status, 403)
  assert.equal(tenantDel.body?.error?.code, 'forbidden')
  assert.ok(fs.existsSync(path.join(root, 'vms', 'vm-mine.json')))

  const adminDel = await makeHandler(root, ADMIN, {}, {}).call('DELETE', '/api/panel/vms/vm-mine')
  assert.equal(adminDel.status, 200, JSON.stringify(adminDel.body))
  assert.equal(adminDel.body?.data?.deleted, 'vm-mine')
})

test('only admins can create or switch keys to the API category', async (t) => {
  const { root, store, key } = keyFixture(t)
  const before = store.list().length
  const create = await makeHandler(root, TENANT, { name: 'direct', category: 'api' }, { apiKeyStore: store }).call(
    'POST',
    '/api/panel/api-keys',
  )
  assert.equal(create.status, 403)
  assert.equal(create.body.error.code, 'tenant_key_fields_forbidden')
  assert.equal(store.list().length, before)

  const patch = await makeHandler(root, TENANT, { category: ' API ' }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(patch.status, 403)
  assert.equal(store.getById(key.id).category, 'oauth')

  const admin = await makeHandler(root, ADMIN, { category: 'api' }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(admin.status, 200, JSON.stringify(admin.body))
  assert.equal(store.getById(key.id).category, 'api')
})

test('admin key edits keep their own user_id while retaining group and slot controls', async (t) => {
  const { root, store, key } = keyFixture(t)
  const out = await makeHandler(
    root,
    ADMIN,
    { user_id: 'u-2', group_id: 7, group_type: 'anthropic', allowed_vms: ['vm-other'] },
    { apiKeyStore: store },
  ).call('PATCH', `/api/panel/api-keys/${key.id}`)
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const saved = store.getById(key.id)
  assert.equal(saved.user_id, 'u-1')
  assert.equal(saved.group_id, 7)
  assert.deepEqual(parseAllowedVms(saved.allowed_vms), ['vm-other'])

  const created = await makeHandler(
    root,
    ADMIN,
    { name: 'for-u2', user_id: 'u-2', group_id: 7, group_type: 'anthropic', allowed_vms: ['vm-other'] },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const rec = store.getById(created.body.item.id)
  assert.equal(rec.user_id, 'u-1')
  assert.equal(rec.group_id, 7)
})

test('admin can create and assign key pools', async (t) => {
  const { root, store, key } = keyFixture(t)
  const pool = createVmPool(new VmPoolsRepo(store.db), { name: 'Shared Pool', vm_ids: [] })
  const created = await makeHandler(
    root,
    ADMIN,
    { name: 'admin-pool-key', vm_pool_id: pool.id },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(store.getById(created.body.item.id).vm_pool_id, pool.id)
  const patched = await makeHandler(root, ADMIN, { vm_pool_id: pool.id }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(patched.status, 200, JSON.stringify(patched.body))
  assert.equal(store.getById(key.id).vm_pool_id, pool.id)
})

function usersFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-users-'))
  // The user routes read the 2FA flag through a bare `SettingsRepo()`, which
  // resolves the process-wide handle, so a detached `createDatabase()` is not
  // enough here. Close it afterwards so the handle does not outlive the test.
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const panelUsers = new PanelUserStore({ db })
  panelUsers.create({ username: 'boss', password: 'boss-pass-1', role: 'admin' })
  return panelUsers
}

test('tenant pauses own Claude and Codex routing without changing runtime or another VM', async (t) => {
  const root = makeProject(t)
  const ids = ['vm-claude', 'vm-codex']
  const vm = (id) => JSON.parse(fs.readFileSync(path.join(root, 'vms', id + '.json'), 'utf8'))
  const post = (id, body, who = TENANT, headers) =>
    makeHandler(root, who, body).call('POST', `/api/panel/vms/${id}/schedulable`, headers)
  const ready = (record) =>
    record.platform === 'openai' ? isCodexSlotReady(record) : isVmScheduleReady(record, { allowMissingCredential: true })
  claudeVm(root, 'vm-other', 'u-2')
  claudeVm(root, 'vm-platform', null)
  for (const [id, platform] of [['vm-claude', 'anthropic'], ['vm-codex', 'openai']]) {
    writeVm(root, { id, platform, status: 'running', owner_user_id: 'u-1', schedulable: true, has_token: true })
    assert.equal(ready(vm(id)), true)
    const paused = await post(id, { schedulable: false })
    assert.equal(paused.status, 200)
    assert.equal(paused.body.data.schedulable, false)
    assert.equal(vm(id).schedule_off_reason, 'tenant_paused')
    assert.equal(vm(id).status, 'running')
    assert.equal(ready(vm(id)), false)
    const record = vm(id)
    assert.equal((await post(id, { schedulable: false })).status, 200)
    assert.deepEqual(vm(id), record)
    assert.equal((await post(id, { schedulable: true })).body.data.schedulable, true)
    assert.equal(ready(vm(id)), true)
    assert.equal(vm(id).status, 'running')
  }
  assert.equal((await post('vm-other', { schedulable: false })).status, 404)
  assert.equal((await post('vm-missing', { schedulable: false })).status, 404)
  assert.equal((await post('vm-platform', { schedulable: false }, { ...TENANT, panelUserId: null })).status, 404)
  assert.equal((await post(ids[0], { schedulable: 'false' })).status, 400)
  assert.equal((await post(ids[0], { schedulable: false, reason: 'maintenance' })).status, 400)
  const headers = { host: 'localhost', 'content-type': 'application/json' }
  assert.equal((await post(ids[0], { schedulable: false }, TENANT, { ...headers, origin: 'https://other.test' })).status, 403)
  assert.equal((await post(ids[0], { schedulable: false }, TENANT, { ...headers, 'content-type': 'text/plain' })).status, 415)

  const transferred = await post(ids[0], () => {
    writeVm(root, { ...vm(ids[0]), owner_user_id: 'u-2' })
    return { schedulable: false }
  })
  assert.equal(transferred.status, 404)
  assert.equal(vm(ids[0]).schedulable, true)
  assert.equal(vm('vm-other').schedule_off, undefined)
})

test('tenant resume clears only the tenant pause and preserves operator and runtime restrictions', async (t) => {
  const root = makeProject(t)
  const id = 'vm-mine'
  const post = (body, who = TENANT) => makeHandler(root, who, body).call('POST', `/api/panel/vms/${id}/schedulable`)
  const vm = () => JSON.parse(fs.readFileSync(path.join(root, 'vms', id + '.json'), 'utf8'))
  const gates = {
    unschedulable: { reason: 'no_credential' },
    schedule_hold: { reason: 'maintenance', detail: { tag: 'upgrade' } },
    temp_unschedulable_reason: 'quota_5h',
    temp_unschedulable_until: Date.now() + 60000,
  }
  writeVm(root, { id, status: 'running', owner_user_id: 'u-1', schedulable: false, ...gates })
  assert.equal((await post({ schedulable: false })).status, 200)
  assert.equal((await post({ schedulable: true })).body.data.schedulable, false)
  for (const [key, value] of Object.entries(gates)) assert.deepEqual(vm()[key], value)
  assert.equal(vm().schedule_off, undefined)

  assert.equal((await post({ schedulable: false, reason: 'tenant_paused' }, ADMIN)).status, 200)
  const operatorOff = vm()
  assert.equal(operatorOff.schedule_off, true)
  assert.notEqual(operatorOff.schedule_off_reason, 'tenant_paused')
  assert.equal((await post({ schedulable: false })).status, 200)
  const rejected = await post({ schedulable: true })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'schedule_operator_off')
  assert.deepEqual(vm(), operatorOff)
})

test('changing a user role or disabling it ends that user panel sessions', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  for (const [i, patch] of [{ role: 'super' }, { enabled: false }].entries()) {
    const user = panelUsers.create({ username: `tenant${i}`, password: 'tenant-pass', role: 'user' })
    const token = createPanelSession(user.username, { role: 'user' })
    const other = createPanelSession('boss', { role: 'admin' })
    const out = await makeHandler(root, ADMIN, patch, { panelUsers }).call('PATCH', `/api/panel/users/${user.id}`)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(verifyPanelSession(token), null, JSON.stringify(patch))
    assert.equal(verifyPanelSession(other)?.user, 'boss')
  }
})

test('unrelated user edits keep sessions alive', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  const user = panelUsers.create({ username: 'quota', password: 'tenant-pass', role: 'user' })
  const token = createPanelSession(user.username, { role: 'user' })
  const out = await makeHandler(root, ADMIN, { vm_create_quota: 3, role: 'user', enabled: true }, { panelUsers }).call(
    'PATCH',
    `/api/panel/users/${user.id}`,
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(verifyPanelSession(token)?.user, 'quota')
})

test('tenant can rename and change password without changing resource ownership', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  const user = panelUsers.create({ username: 'self-service', password: 'tenant-pass', role: 'user', concurrency: 12 })
  const other = panelUsers.create({ username: 'another-tenant', password: 'another-pass', role: 'user' })
  const keyStore = new ApiKeyStore({ db: panelUsers.db })
  const key = keyStore.create({ name: 'owned-key', user_id: user.id })
  claudeVm(root, 'vm-mine', user.id)
  claudeVm(root, 'vm-other', other.id)
  const settings = new SettingsRepo(panelUsers.db)
  const onboarding = { status: 'completed', guide_used: true }
  settings.set('onboarding_state', { [user.username]: onboarding })
  const token = createPanelSession(user.username, { role: 'user' })
  const second = createPanelSession(user.username, { role: 'user' })
  const staleTarget = createPanelSession('my-new-name', { role: 'user' })
  const otherToken = createPanelSession(other.username, { role: 'user' })
  const tenant = { panelUser: user.username, panelRole: 'user', panelUserId: user.id }
  const change = (body, headers = {}, who = tenant, session = token) =>
    makeHandler(root, who, body, { panelUsers }).call('PATCH', '/api/panel/me', {
      host: 'localhost',
      'content-type': 'application/json',
      authorization: `Bearer ${session}`,
      ...headers,
    })

  assert.equal((await change({ current_password: 'wrong', username: 'my-new-name' })).status, 403)
  assert.equal((await change({ current_password: 'tenant-pass', username: 'ANOTHER-TENANT' })).status, 409)
  assert.equal((await change({ current_password: 'tenant-pass', user_id: other.id })).status, 400)
  assert.equal((await change({ current_password: 'tenant-pass', role: 'admin' })).status, 400)
  assert.equal((await change({ current_password: 'tenant-pass', password: 'short' })).status, 400)
  assert.equal((await change({ current_password: 'tenant-pass' }, { origin: 'https://other.test' })).status, 403)
  assert.equal((await change({ current_password: 'tenant-pass' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await change({ current_password: 'tenant-pass' }, {}, { apiKeyKind: 'master' })).status, 403)
  assert.ok(verifyPanelSession(token))

  const result = await change({ current_password: 'tenant-pass', username: 'my-new-name', password: 'new-password' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body.data, { user: 'my-new-name' })
  assert.equal(verifyPanelSession(token), null)
  assert.equal(verifyPanelSession(second), null)
  assert.equal(verifyPanelSession(staleTarget), null)
  assert.equal(verifyPanelSession(otherToken)?.user, other.username)
  assert.equal(panelUsers.authenticate(user.username, 'tenant-pass'), null)
  assert.equal(panelUsers.authenticate('my-new-name', 'tenant-pass'), null)
  assert.equal(panelUsers.authenticate('my-new-name', 'new-password')?.id, user.id)
  assert.equal(panelUsers.getById(user.id).concurrency, 12)
  assert.deepEqual(settings.get('onboarding_state'), { 'my-new-name': onboarding })
  assert.equal(keyStore.authenticate(key.key).record.user_id, user.id)
  const currentTenant = { ...tenant, panelUser: 'my-new-name' }
  const vms = await makeHandler(root, currentTenant, null, {
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
  }).call('GET', '/api/panel/vms')
  assert.deepEqual(vms.body.data.items.map((vm) => vm.id), ['vm-mine'])
  assert.equal((await change({ current_password: 'new-password', password: 'lost-session' })).status, 401)

  const newToken = createPanelSession('my-new-name', { role: 'user' })
  assert.equal(
    (await change({ current_password: 'new-password', password: 'next-password' }, {}, currentTenant, newToken)).status,
    200,
  )
  assert.equal(verifyPanelSession(newToken), null)
  assert.equal(panelUsers.authenticate('my-new-name', 'next-password')?.id, user.id)
})

test('all panel roles can list test models; tenants cannot manage test schedules', () => {
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('GET', '/api/panel/test-models', role).ok, true, role)
  }
  for (const role of ['user', 'super']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal(authorizePanelRoute(method, '/api/panel/test-models', role).ok, false, `${role} ${method}`)
    }
  }
  assert.equal(authorizePanelRoute('GET', '/api/panel/test-models/x', 'user').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/test-schedule/default', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/test-chat', 'super').ok, false)
})

test('tenant test-models: own slot lists models, foreign slot 404s, refresh never goes live', async (t) => {
  const root = makeProject(t)
  // A listener standing in for the slot SOCKS5: any connection means a live catalog refresh ran.
  let dials = 0
  const socks = net.createServer((socket) => {
    dials += 1
    socket.destroy()
  })
  await new Promise((resolve) => socks.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => socks.close(resolve)))
  const proxy = { host: '127.0.0.1', port: socks.address().port }
  for (const [id, owner] of [
    ['vm-mine', 'u-1'],
    ['vm-other', 'u-2'],
  ]) {
    codexVm(root, id, owner)
    const file = path.join(root, 'vms', `${id}.json`)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), proxy }))
  }
  // Fresh catalog-version cache so a refresh never reaches the public registry.
  fs.writeFileSync(
    path.join(dataDir, 'codex-catalog-client.json'),
    JSON.stringify({ version: '0.160.0', fetched_at: new Date().toISOString() }),
  )

  const own = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-mine&refresh=1')
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.equal(dials, 0)

  const foreign = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-other')
  assert.equal(foreign.status, 404)
  const missing = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-nope')
  assert.deepEqual(foreign.body, missing.body)

  const superUser = { panelUser: 'ops', panelRole: 'super', panelUserId: 'u-9' }
  const sup = await makeHandler(root, superUser, null).call('GET', '/api/panel/test-models?vm_id=vm-other&refresh=1')
  assert.equal(sup.status, 200)
  assert.equal(dials, 0)

  const admin = await makeHandler(root, ADMIN, null).call('GET', '/api/panel/test-models?vm_id=vm-other&refresh=1')
  assert.equal(admin.status, 200)
  assert.ok(dials > 0, 'admin refresh still goes live')
})

test('active usage query checks tenant ownership and request policy before contacting the slot', async (t) => {
  const root = makeProject(t)
  claudeVm(root, 'vm-mine', 'u-1')
  claudeVm(root, 'vm-other', 'u-2')
  claudeVm(root, 'vm-platform', null)
  const url = (id) => `/api/panel/vms/${id}/usage/query`
  const foreign = await makeHandler(root, TENANT, {}).call('POST', url('vm-other'))
  assert.equal(foreign.status, 404)
  assert.deepEqual(foreign, await makeHandler(root, TENANT, {}).call('POST', url('vm-missing')))
  assert.deepEqual(foreign, await makeHandler(root, TENANT, {}).call('POST', url('vm-platform')))
  const noOwner = { ...TENANT, panelUserId: null }
  assert.equal((await makeHandler(root, noOwner, {}).call('POST', url('vm-platform'))).status, 404)
  assert.equal((await makeHandler(root, { apiKeyKind: 'managed' }, {}).call('POST', url('vm-mine'))).status, 403)
  const headers = { host: 'localhost', 'content-type': 'application/json' }
  const crossOrigin = await makeHandler(root, TENANT, {}).call('POST', url('vm-mine'), {
    ...headers,
    origin: 'https://foreign.example',
  })
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.body.error.code, 'origin_denied')
  const nonJson = await makeHandler(root, TENANT, {}).call('POST', url('vm-mine'), { host: headers.host })
  assert.equal(nonJson.status, 415)

  const own = await makeHandler(root, TENANT, {}).call('POST', url('vm-mine'), {
    ...headers,
    origin: 'http://localhost',
  })
  assert.equal(own.status, 400)
  assert.equal(own.body.error.code, 'no_oauth_token')
  const adminOwn = await makeHandler(root, ADMIN, {}).call('POST', url('vm-mine'))
  assert.equal(adminOwn.status, 400)
  assert.equal(adminOwn.body.error.code, 'no_oauth_token')
  const missing = await makeHandler(root, ADMIN, {}).call('POST', url('vm-missing'))
  assert.equal(missing.status, 404)
  const denied = await makeHandler(root, { ...TENANT, panelRole: 'super' }, {}).call('POST', url('vm-mine'))
  assert.equal(denied.status, 403)
})

test('an owned-slot usage query reads official windows without using a card or writing usage charges', async (t) => {
  const root = makeProject(t)
  const id = 'vm-mine'
  const accountId = 'mock-account'
  const accountQuota = new AccountQuota({ db: createDatabase({ dataDir: path.join(root, 'data') }) })
  t.after(() => accountQuota.db.close())
  const receipt = path.join(root, 'data', 'claude-reset-state.json')
  fs.writeFileSync(receipt, '{"fences":{},"operations":{}}\n')
  const savedReceipt = fs.readFileSync(receipt, 'utf8')
  const vm = {
    id,
    owner_user_id: 'u-1',
    platform: 'anthropic',
    family: 'claude',
    claude: { mode: 'oauth', has_access: true, account_uuid: accountId },
  }
  writeVm(root, vm)
  const stub = path.join(root, 'docker.cjs')
  const calls = path.join(root, 'worker-calls')
  const settings = path.join(root, 'worker-settings.json')
  const setReading = (value) => fs.writeFileSync(settings, JSON.stringify(value))
  setReading({ utilization: 35 })
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const op = argv[argv.indexOf('oauth') + 1]
fs.appendFileSync(${JSON.stringify(calls)}, op + '\\n')
if (argv[0] !== 'exec' || !['profile', 'usage'].includes(op)) process.exit(2)
const reading = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, 'utf8'))
if (op === 'usage' && reading.owner) {
  const file = ${JSON.stringify(path.join(root, 'vms', `${id}.json`))}
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), owner_user_id: reading.owner }))
}
const status = op === 'profile' ? 200 : reading.status || 200
const body = op === 'profile' ? {} : status === 200
  ? { five_hour: { utilization: 21 }, seven_day: { utilization: reading.utilization }, seven_day_opus: null }
  : { error: { message: 'mock upstream operational detail' } }
process.stdout.write(JSON.stringify({ ok: status === 200, status, body }) + '\\n')
`,
    { mode: 0o700 },
  )
  const docker = process.env.KIN_DOCKER_BIN
  process.env.KIN_DOCKER_BIN = stub
  t.after(() => {
    if (docker === undefined) delete process.env.KIN_DOCKER_BIN
    else process.env.KIN_DOCKER_BIN = docker
  })
  const url = `/api/panel/vms/${id}/usage/query`
  const scheduling = []
  const poolScheduler = {
    syncQuotaSchedule: (slot, account) => scheduling.push([slot.id, account.unified.official['7d'].utilization]),
    signalChange: () => scheduling.push('signal'),
    notifyCapacity: () => scheduling.push('capacity'),
  }
  const query = () => makeHandler(root, TENANT, {}, { accountQuota, poolScheduler }).call('POST', url)
  const own = await query()
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.equal(own.body.data.vm_id, id)
  assert.equal(own.body.data.seven_day.utilization, 0.35)
  assert.equal(accountQuota.repo.get(accountId).unified.official['7d'].utilization, 0.35)

  setReading({ status: 502 })
  const failed = await query()
  assert.equal(failed.status, 502)
  assert.doesNotMatch(JSON.stringify(failed.body), /mock upstream operational detail/)

  setReading({ utilization: 72, owner: 'u-2' })
  const reassigned = await query()
  assert.equal(reassigned.status, 404)
  assert.equal(reassigned.body.data, undefined)
  assert.equal(accountQuota.repo.get(accountId).unified.official['7d'].utilization, 0.35)
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').sort(), [
    'profile', 'profile', 'profile', 'usage', 'usage', 'usage',
  ])
  assert.deepEqual(scheduling, [[id, 0.35], 'signal', 'capacity'])
  assert.equal(fs.readFileSync(receipt, 'utf8'), savedReceipt)
  assert.equal(accountQuota.db.prepare('SELECT COUNT(*) AS count FROM usage_logs').get().count, 0)
})
