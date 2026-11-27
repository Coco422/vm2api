/** Original admin UI + selected original panel routes, restricted to owned synthetic state. */
import path from 'node:path'
import { PanelUserStore } from '../src/lib/admin/panel-users.mjs'
import { createPanelHandler } from '../src/lib/admin/panel-routes.mjs'
import { SettingsRepo } from '../src/lib/db/repos/settings-repo.mjs'
import { RequestLogStore } from '../src/lib/admin/request-log.mjs'
import { attachPanelAuth, extractPanelToken, verifyPanelSession } from '../src/lib/core/security.mjs'
import { applyOnboardingAction } from '../src/lib/admin/onboarding.mjs'
import { createRoutingRuntime } from '../src/lib/admin/routing-runtime.mjs'
import { buildVmDetail } from '../src/lib/admin/panel-api.mjs'
import { denyIfUserMissesVm } from '../src/lib/admin/panel-tenant.mjs'

export const LOCAL_ADMIN = { username: 'localadmin', password: 'local-admin-8791' }

export function createSandboxPanel({ db, project, accountQuota, apiKeyStore, json, readBody, record }) {
  const panelUsers = new PanelUserStore({ db, projectRoot: project })
  if (!panelUsers.getByUsername(LOCAL_ADMIN.username)) panelUsers.create({ ...LOCAL_ADMIN, role: 'admin' })
  attachPanelAuth({
    authenticate: (user, password) => panelUsers.authenticate(user, password),
    lookupRole: (user) => panelUsers.getByUsername(user)?.role || null,
  })
  const settings = new SettingsRepo(db)
  settings.set(
    'onboarding_state',
    applyOnboardingAction(settings.get('onboarding_state', {}), LOCAL_ADMIN.username, 'dismiss'),
  )
  const cfg = {
    base_url: 'http://127.0.0.1:8791',
    paths: { project, root: path.join(project, 'src'), data: path.join(project, 'data') },
    limits: { max_body_bytes: 65536 },
  }
  const routingConfig = {
    concurrency: { default_max_per_account: 2, default_key_concurrency: 2 },
    quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8 },
  }
  const proxyPool = {
    state: { proxies: [], config: {} },
    snapshot: () => ({ proxies: [], config: {}, total: 0 }),
    panelSnapshot: () => ({ proxies: [], config: {}, totals: { total: 0 } }),
    publicProxy: (proxy) => ({ id: proxy.id }),
    getProxyForVm: (id) =>
      ['alice-vm', 'bob-vm', 'alice-recovery-vm'].includes(id) ? { id: `fixture-proxy-${id}` } : null,
  }
  const requestLog = new RequestLogStore({ db, dataDir: path.join(project, 'data') })
  const bodies = new WeakMap()
  const read = async (req, max) => {
    if (!bodies.has(req)) bodies.set(req, await readBody(req, max))
    return bodies.get(req)
  }
  const requireAuth = (req, res) => {
    const session = verifyPanelSession(extractPanelToken(req))
    const user = session ? panelUsers.getByUsername(session.user) : null
    if (!user || user.enabled === false) {
      json(res, 401, { ok: false, error: { code: 'panel_login_required', message: '请登录本地测试账号' } })
      return false
    }
    Object.assign(req, {
      panelUser: user.username,
      panelRole: user.role,
      panelUserId: user.id,
      panelVmCreateQuota: user.vm_create_quota,
    })
    return true
  }
  const recovered = new Set()
  const kernelRecoveryOps = {
    cluster: () => null,
    settleMs: 0,
    stopSlot: async () => ({ ok: true }),
    powerOn: async ({ id }) => {
      recovered.add(id)
      record('sandbox-recovery', { vm_id: id })
      return { ok: true }
    },
    diagnose: async (vm) => {
      const fault = vm.id === 'alice-recovery-vm' && !recovered.has(vm.id) && Boolean(vm.unschedulable)
      return {
        vm_id: vm.id,
        checked_at: new Date().toISOString(),
        ok: !fault,
        engine: 'rust',
        placement: 'local',
        first_failure: fault ? 'kernel' : null,
        checks: [
          {
            id: 'kernel',
            label: '推理内核',
            status: fault ? 'error' : 'ok',
            code: fault ? 'kernel_down' : null,
            message: fault ? '合成示例：槽内运行时异常' : '合成示例：推理内核已就绪',
          },
        ],
      }
    },
  }
  const context = {
    cfg,
    routingConfig,
    panelUsers,
    apiKeyStore,
    accountQuota,
    json,
    readBody: read,
    requireAuth,
    proxyPool,
    requestLog,
    stats: {},
    kernelRecoveryOps,
    poolScheduler: { snapshot: () => ({}) },
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
  }
  const original = createPanelHandler(context)
  const runtime = createRoutingRuntime(context)
  context.applyVmQuotaOverride = runtime.applyVmQuotaOverride
  const detail = async (id, role) =>
    buildVmDetail({
      ...context,
      id,
      role,
      kernelHealth: async () => ({ rust: { reachable: false, error_code: 'local_fixture' } }),
      slotProcessStatus: async () => ({ telemetry: { enabled: false, running: false }, process_topology: null }),
    })
  const exactRead = new Set([
    '/api/panel/me',
    '/api/panel/onboarding',
    '/api/panel/users',
    '/api/panel/api-keys',
    '/api/panel/vm-pools',
    '/api/panel/vms',
    '/api/panel/proxies',
    '/api/panel/dashboard',
    '/api/panel/usage',
    '/api/panel/routing',
    '/api/panel/version',
    '/api/panel/statistics',
    '/api/panel/statistics/leaderboard',
    '/api/panel/usage-logs/overview',
  ])
  const originalAllowed = (method, p) =>
    (method === 'GET' &&
      (exactRead.has(p) ||
        /^\/api\/panel\/api-keys\/[^/]+\/stats$/.test(p) ||
        /^\/api\/panel\/vms\/[^/]+\/diagnose$/.test(p))) ||
    (method === 'POST' &&
      (p === '/api/panel/login' ||
        p === '/api/panel/logout' ||
        p === '/api/panel/users' ||
        p === '/api/panel/api-keys' ||
        /^\/api\/panel\/vms\/[^/]+\/(?:schedulable|recover)$/.test(p) ||
        /^\/api\/panel\/api-keys\/[^/]+\/(reveal|rotate|reset-quota)$/.test(p))) ||
    (method === 'PATCH' &&
      /^\/api\/panel\/(me|users\/[^/]+|api-keys\/[^/]+|vms\/[^/]+\/(owner|quota-thresholds))$/.test(p)) ||
    (method === 'PUT' && p === '/api/panel/onboarding')

  return async (req, res, url) => {
    const p = url.pathname
    if (!p.startsWith('/api/panel') && !p.startsWith('/admin')) return false
    res.setHeader('Cache-Control', 'no-store')
    if (p !== '/api/panel/login' && !requireAuth(req, res)) return true
    if (p === '/api/panel/pool/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      res.write(
        `event: seats\ndata: ${JSON.stringify({ seats: {}, global_queue_depth: 0, queue_max: 0, ts: Date.now() })}\n\n`,
      )
      return true
    }
    if (p === '/api/panel/statistics/vm-batches' && req.method === 'GET')
      return json(res, 200, {
        ok: true,
        data: [
          { batch: '演示第一批', started: 3, active: 2, stopped: 1, medianSurvivalDays: 8.2 },
          { batch: '演示第二批', started: 1, active: 1, stopped: 0, medianSurvivalDays: null },
        ],
      })
    if (p === '/api/panel/cluster/nodes' && req.method === 'GET')
      return json(res, 200, { ok: true, data: { items: [] } })
    if (p === '/api/panel/test-models' && req.method === 'GET')
      return json(res, 200, { ok: true, data: { models: [] } })
    const vm = p.match(/^\/api\/panel\/vms\/([^/]+)$/)
    if (vm && (req.method === 'GET' || req.method === 'PATCH')) {
      if (denyIfUserMissesVm(req, res, { projectRoot: project, json, path: p })) return true
      if (req.method === 'PATCH') {
        if (req.panelRole !== 'admin') return json(res, 403, { ok: false, error: { code: 'forbidden' } })
        const body = await read(req, 8192)
        const fields = ['max_concurrency', 'max_rpm', 'session_slots']
        if (!Object.keys(body).length || Object.keys(body).some((key) => !fields.includes(key)))
          return json(res, 400, { ok: false, error: { message: '本地沙箱仅开放并发、RPM 与席位策略修改' } })
        for (const [key, value] of Object.entries(body)) {
          const max = key === 'max_rpm' ? 1_000_000 : 256
          if (
            value !== null &&
            (typeof value !== 'number' ||
              !Number.isInteger(value) ||
              value < (key === 'session_slots' ? 1 : 0) ||
              value > max)
          )
            return json(res, 400, { ok: false, error: { message: '限额参数无效' } })
        }
        // Same file-persistence functions as the gateway; the running worker is intentionally absent.
        for (const [key, value] of Object.entries(body)) {
          const methods = {
            max_concurrency: ['applyVmConcurrency', 'concurrency'],
            max_rpm: ['applyVmRpm', 'rpm'],
            session_slots: ['applyVmSessionSlots', 'sessionSlots'],
          }
          const [method, inherit] = methods[key]
          const saved =
            value === null ? runtime.inheritVmScheduling(vm[1], { [inherit]: true }) : runtime[method](vm[1], value)
          if (!saved) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        record('sandbox-vm-policy', { vm_id: vm[1], fields: Object.keys(body) })
      }
      const result = await detail(vm[1], req.panelRole)
      return result.status ? json(res, result.status, result.body) : json(res, 200, result)
    }
    if (!originalAllowed(req.method, p)) {
      record('sandbox-panel-blocked', { method: req.method, path: p })
      return json(res, 409, {
        ok: false,
        error: {
          code: 'sandbox_operation_blocked',
          message: '本地沙箱只开放员工、VM 分配、Key 和并发额度管理；容器、真实授权、集群与部署操作已禁用',
        },
      })
    }
    if (req.method !== 'GET') record('sandbox-panel-write', { method: req.method, path: p })
    return original(req, res, url)
  }
}
