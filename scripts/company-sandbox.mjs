/** Local acceptance fixture. Real employee auth / SQLite / routes; simulated upstream only. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

export async function startSandbox({ root, sandbox, record, port = 8791, installSignals = true }) {
  // Set isolation BEFORE importing security/config modules. Never start the production server.
  process.env.KIN_DATA_DIR = path.join(sandbox, 'data')
  for (const name of Object.keys(process.env))
    if (/^(VM2API_|KIN_|ANTHROPIC_|OPENAI_)/.test(name) && name !== 'KIN_DATA_DIR') delete process.env[name]
  for (const name of ['PUBLIC_BASE_URL', 'PUBLIC_SCHEME', 'PANEL_CORS_ORIGINS']) delete process.env[name]
  const [
    { openDatabase, closeDatabase },
    { ApiKeyStore },
    { UsageLogsRepo },
    { createEmployeeHandler },
    { tryServeWebDist },
    { setPriceCatalogTestHooks },
  ] = await Promise.all([
    import('../src/lib/db/database.mjs'),
    import('../src/lib/admin/api-keys.mjs'),
    import('../src/lib/db/repos/usage-logs-repo.mjs'),
    import('../src/company/employee-api.mjs'),
    import('../src/lib/http/web-dist.mjs'),
    import('../src/lib/admin/price-catalog.mjs'),
  ])
  setPriceCatalogTestHooks({ backgroundRefresh: false })
  globalThis.fetch = async () => {
    throw new Error('External requests disabled in acceptance sandbox')
  }
  const db = openDatabase({ dbPath: path.join(sandbox, 'data/demo.db') })
  const apiKeyStore = new ApiKeyStore({ db, hashSecret: 'company-local-fixture-only' })
  const project = path.join(sandbox, 'fixture')
  fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
  const keys = { alice: 'sk-vm-local-demo-alice', bob: 'sk-vm-local-demo-bob' }
  for (const name of ['alice', 'bob']) {
    if (!apiKeyStore.users.getById(name))
      apiKeyStore.users.insert({
        id: name,
        username: name,
        role: 'user',
        password_hash: 'not-a-login-hash',
        enabled: true,
      })
    if (!apiKeyStore.repo.getByHash(apiKeyStore._hash(keys[name])))
      apiKeyStore.create({
        name: `${name} 的专属 Key`,
        key: keys[name],
        user_id: name,
        group_type: 'anthropic',
        allowed_vms: [`${name}-vm`],
        quota: name === 'alice' ? 0 : 100,
        max_concurrency: 2,
        rate_limit_5h: name === 'alice' ? 0 : 20,
        quota_requests: name === 'alice' ? 0 : 10000,
      })
    if (!fs.existsSync(path.join(project, 'vms', `${name}-vm.json`)))
      fs.writeFileSync(
        path.join(project, 'vms', `${name}-vm.json`),
        JSON.stringify({
          id: `${name}-vm`,
          name: `${name === 'alice' ? '研发' : '设计'}专属账号`,
          owner_user_id: name,
          origin: 'admin_assigned',
          platform: 'anthropic',
          schedulable: true,
          claude: { mode: 'oauth', has_access: true, scope: 'user:profile user:inference', account_tier: 'pro' },
        }),
      )
  }
  for (const id of ['spare-vm-1', 'spare-vm-2']) {
    const file = path.join(project, 'vms', `${id}.json`)
    if (!fs.existsSync(file))
      fs.writeFileSync(
        file,
        JSON.stringify({
          id,
          name: `待分配测试 VM ${id.endsWith('1') ? '1' : '2'}`,
          owner_user_id: null,
          origin: 'platform',
          platform: 'anthropic',
          status: 'running',
          schedulable: true,
          claude: { mode: 'oauth', has_access: true, scope: 'user:profile user:inference', account_tier: 'pro' },
        }),
      )
  }
  const logs = new UsageLogsRepo(db)
  {
    for (const name of ['alice', 'bob']) {
      const key = apiKeyStore.repo.getByHash(apiKeyStore._hash(keys[name]))
      for (let day = 0; day < 7; day++)
        for (let i = 0; i < (day === 0 ? 25 : 8 - day); i++) {
          const id = `${name}-${day}-${i}`
          if (db.prepare('SELECT 1 FROM usage_logs WHERE request_id = ?').get(id)) continue
          const cost = 0.12 + i * 0.01
          const unpriced = day === 0 && i === 24
          logs.insertSummary({
            id,
            request_id: id,
            created_at: new Date(Date.now() - day * 86400_000 - i * 60000).toISOString(),
            user_id: name,
            api_key_id: key.id,
            vm_id: `${name}-vm`,
            status: day === 0 && i === 23 ? 500 : 200,
            protocol: 'anthropic.messages',
            stream: true,
            duration_ms: 850 + i * 40,
            first_token_ms: 150 + i * 10,
            model: i % 3 ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
            input_tokens: 4300,
            output_tokens: 1200,
            cache_read_tokens: 18000,
            cache_creation_tokens: 3200,
            cache_creation_1h_tokens: 3200,
            input_cost: unpriced ? null : 0.01,
            output_cost: unpriced ? null : 0.03,
            cache_read_cost: unpriced ? null : 0.01,
            cache_creation_cost: unpriced ? null : cost - 0.05,
            total_cost: unpriced ? null : cost,
            actual_cost: unpriced ? null : cost,
          })
          apiKeyStore.repo.recordUsage(key.id, {
            cost: unpriced ? 0 : cost,
            tokens_in: 4300,
            tokens_out: 1200,
            cache_read_tokens: 18000,
            cache_creation_tokens: 3200,
          })
        }
    }
  }
  const utilization = new Map([
    ['alice-vm', 0.42],
    ['bob-vm', 0.7],
  ])
  const remaining = new Map([
    ['alice-vm', 2],
    ['bob-vm', 1],
  ])
  const receipts = new Map()
  const accountQuota = {
    config: { safety_ratio: 0.85, weekly_safety_ratio: 0.8 },
    setMaxConcurrency() {},
    setMaxRpm() {},
    snapshot: () => ({
      accounts: [...utilization].map(([id, used]) => ({
        vm_id: id,
        account_id: `account-${id}`,
        last_probe: { ok: true, at: new Date().toISOString() },
        unified: {
          '5h': { utilization: used, reset: new Date(Date.now() + 3 * 3600_000).toISOString() },
          '7d': { utilization: 0.27, reset: new Date(Date.now() + 4 * 86400_000).toISOString() },
        },
      })),
    }),
  }
  const operations = {}
  for (const name of [
    'buildProbeOne',
    'buildOpenaiQuotaRefresh',
    'buildOpenaiQuotaReset',
    'buildClaudeResetQuery',
    'buildClaudeResetRedeem',
  ]) {
    operations[name] = async ({ id, idempotencyKey }) => {
      record('simulated-upstream', { operation: name, vm_id: id })
      const redeem = name.endsWith('Redeem') || name.endsWith('Reset')
      const receipt = `${id}:${idempotencyKey}`
      if (redeem && !receipts.has(receipt)) {
        if (!remaining.get(id)) return { status: 409, ok: false }
        remaining.set(id, remaining.get(id) - 1)
        utilization.set(id, 0)
        receipts.set(receipt, true)
      }
      const count = remaining.get(id)
      return {
        ok: true,
        data: {
          outcome: redeem ? 'reset' : null,
          claude_reset_credits: {
            available_count: count,
            fetched_at: new Date().toISOString(),
            credits: [
              {
                label: '本地模拟重置券',
                resets_left: count,
                redeemable: count > 0,
                expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
              },
            ],
          },
        },
      }
    }
  }
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
    return true
  }
  const readBody = async (req, maxBytes) => {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (Buffer.byteLength(body) > maxBytes) throw new Error('Body too large')
    }
    return JSON.parse(body || '{}')
  }
  const handler = createEmployeeHandler({
    enabled: true,
    cfg: { paths: { project } },
    apiKeyStore,
    accountQuota,
    operations,
    json,
    readBody,
  })
  const { createSandboxPanel, LOCAL_ADMIN } = await import('./company-panel.mjs')
  const handlePanel = createSandboxPanel({ db, project, accountQuota, apiKeyStore, json, readBody, record })
  const site = path.join(sandbox, 'site')
  if (!fs.existsSync(path.join(site, 'web/dist/index.html'))) {
    closeDatabase()
    throw new Error('Run company-local.mjs build before serve')
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if ((await handler(req, res, url)) !== false) return
      if ((await handlePanel(req, res, url)) !== false) return
      if (req.method === 'GET' && tryServeWebDist(res, site, url.pathname === '/' ? '/cc' : url.pathname)) return
      json(res, 404, { ok: false, error: { message: 'Only local fixture routes are available' } })
    } catch {
      if (!res.headersSent) json(res, 500, { ok: false, error: { message: 'Local fixture failure' } })
      else res.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const close = async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    closeDatabase()
  }
  const stop = () => {
    void close().then(() => process.exit(0))
  }
  if (installSignals) {
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  }
  const localPort = server.address().port
  console.log(`Local fixture: http://127.0.0.1:${localPort}/cc#/employee`)
  console.log(
    `Local admin: http://127.0.0.1:${localPort}/cc#/login (${LOCAL_ADMIN.username}; password in docs/COMPANY_SUBSCRIPTIONS.md)`,
  )
  console.log('Synthetic employee Key: sk-vm-local-demo-alice (bob available for isolation checks)')
  return { server, db, close, project, apiKeyStore }
}
