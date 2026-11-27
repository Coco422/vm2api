import { cragShopRoute } from './crag-shop.mjs'

/**
 * Panel RBAC.
 *
 *   admin  — full console + user management
 *   super  — overview / cluster / logs / statistics + VM page (schedule only)
 *   user   — tenant: owned VM usage, quota thresholds and reset credits; client keys, logs and statistics
 */

export const PANEL_VIEWS = [
  'overview',
  'cluster',
  'vm',
  'import',
  'pools',
  'specs',
  'proxies',
  'models',
  'risk',
  'system',
  'keys',
  'api',
  'anthropic',
  'logs',
  'statistics',
  'database',
  'settings',
  'users',
  'wrap',
  'billing',
  'crag-subscription',
]

const ROLE_VIEWS = {
  user: ['vm', 'keys', 'logs', 'statistics'],
  super: ['overview', 'cluster', 'logs', 'statistics', 'vm'],
  admin: PANEL_VIEWS.slice(),
}

const ROLE_CAPS = {
  user: [
    'panel.read',
    'account.manage',
    'vm.read',
    'vm.schedule.self',
    'vm.recover.self',
    'vm.reset_credits',
    'vm.quota_thresholds',
    'keys.read',
    'keys.manage',
  ],
  super: ['panel.read', 'vm.read', 'vm.schedule'],
  admin: ['*'],
}

export function normalizePanelRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'admin' || r === 'super' || r === 'user') return r
  return 'user'
}

export function viewsForRole(role) {
  return (ROLE_VIEWS[normalizePanelRole(role)] || ROLE_VIEWS.user).slice()
}

export function capabilitiesForRole(role) {
  return (ROLE_CAPS[normalizePanelRole(role)] || ROLE_CAPS.user).slice()
}

export function hasCapability(role, cap) {
  const caps = capabilitiesForRole(role)
  return caps.includes('*') || caps.includes(cap)
}

export function canViewPage(role, view) {
  return viewsForRole(role).includes(view)
}

export function panelIdentity(req) {
  if (req?.apiKeyKind === 'master') {
    return { user: 'master', role: 'admin', source: 'master_key' }
  }
  return {
    user: req?.panelUser || null,
    role: normalizePanelRole(req?.panelRole || 'user'),
    source: 'session',
  }
}

const USER_EXACT_GET = new Set([
  '/api/panel/me',
  '/api/panel/onboarding',
  '/api/panel/test-models',
  '/api/panel/vms',
  '/api/panel/pool/stream',
  '/api/panel/api-keys',
  '/api/panel/request-logs',
  '/api/panel/request-logs/stats',
])

function isRequestLogPath(path) {
  return (
    path === '/api/panel/request-logs' ||
    path === '/api/panel/request-logs/export' ||
    path === '/api/panel/request-logs/stats' ||
    /^\/api\/panel\/request-logs\/[^/]+$/.test(path) ||
    /^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(path)
  )
}

/** Scrolling log page + statistics: read-only, owner-scoped server-side for `user`. */
const LOG_STATS_GET = new Set([
  '/api/panel/usage-logs',
  '/api/panel/usage-logs/summary',
  '/api/panel/usage-logs/filter-options',
  '/api/panel/usage-logs/session-suggestions',
  '/api/panel/usage-logs/active-sessions',
  '/api/panel/usage-logs/overview',
  '/api/panel/statistics',
  '/api/panel/statistics/leaderboard',
  '/api/panel/statistics/vm-batches',
])

function isSuperVmRead(path) {
  if (path === '/api/panel/vms/fleet-status' || path === '/api/panel/vms/create-options') return false
  return /^\/api\/panel\/vms\/[^/]+$/.test(path)
}

function isSuperSchedule(method, path) {
  if (method !== 'POST') return false
  return (
    /^\/api\/panel\/vms\/[^/]+\/schedulable$/.test(path) ||
    /^\/api\/panel\/vms\/[^/]+\/cooldown\/clear$/.test(path) ||
    /^\/api\/panel\/vms\/[^/]+\/circuit\/reset$/.test(path)
  )
}

/** Explicit tenant allowlist: new VM management endpoints remain admin-only. */
function isUserAllowed(method, path) {
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')
  if (m === 'GET') {
    if (USER_EXACT_GET.has(p) || LOG_STATS_GET.has(p)) return true
    if (/^\/api\/panel\/vms\/[^/]+\/diagnose$/.test(p)) return true
    if (/^\/api\/panel\/request-logs\/[^/]+(?:\/attempts)?$/.test(p)) return p !== '/api/panel/request-logs/export'
    if (/^\/api\/panel\/vms\/[^/]+$/.test(p))
      return ![
        'create',
        'create-options',
        'import',
        'package',
        'fleet-status',
        'fleet-update',
        'reconcile-fingerprints',
      ].includes(p.split('/').pop())
    return /^\/api\/panel\/api-keys\/[^/]+(?:\/stats)?$/.test(p)
  }
  if (m === 'PUT' && p === '/api/panel/onboarding') return true
  if (m === 'PATCH' && p === '/api/panel/me') return true
  if (m === 'PATCH' && /^\/api\/panel\/vms\/[^/]+\/quota-thresholds$/.test(p)) return true
  if ((m === 'PATCH' || m === 'DELETE') && /^\/api\/panel\/api-keys\/[^/]+$/.test(p)) return true
  if (m !== 'POST') return false
  if (p === '/api/panel/api-keys') return true
  if (/^\/api\/panel\/vms\/[^/]+\/(?:test-chat|count-tokens|schedulable|recover)$/.test(p)) return true
  // Client keys are needed by the tenant's API client; VM/upstream secrets are never exposed.
  if (/^\/api\/panel\/api-keys\/[^/]+\/(?:reveal|rotate|reset-quota)$/.test(p)) return true
  return /^\/api\/panel\/vms\/[^/]+\/(?:usage\/query|openai-quota\/(?:refresh|reset)|claude-reset\/(?:query|redeem))$/.test(
    p,
  )
}

export function authorizePanelRoute(method, path, role) {
  const r = normalizePanelRole(role)
  if (r === 'admin') return { ok: true, role: r }
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')

  const shopRoute = cragShopRoute(m, p)
  if (shopRoute) return { ok: false, role: r, code: 'forbidden', message: 'Forbidden' }

  if (/^\/api\/panel\/vms\/[^/]+\/migration(?:\/|$)/.test(p)) {
    return { ok: false, role: r, code: 'forbidden', message: '只有管理员可以迁移槽位' }
  }

  // Kernel cache, license inventory and installation are operator-only, like /wrap-cli.
  if (p === '/api/panel/kernels' || p.startsWith('/api/panel/kernels/')) {
    return { ok: false, role: r, code: 'forbidden', message: '只有管理员可以管理内核' }
  }
  if (p === '/api/panel/test-schedule/default' && m === 'PUT') {
    return { ok: false, role: r, code: 'forbidden', message: '当前权限无法执行此操作' }
  }

  if (r === 'user' && isUserAllowed(m, p)) return { ok: true, role: r }
  if (p === '/api/panel/onboarding' && (m === 'GET' || m === 'PUT')) return { ok: true, role: r }
  if (
    r === 'super' &&
    m === 'GET' &&
    (p === '/api/panel/dashboard' ||
      p === '/api/panel/usage' ||
      p === '/api/panel/vms' ||
      p === '/api/panel/pool/stream' ||
      p === '/api/panel/cluster/nodes' ||
      p === '/api/panel/cluster/local' ||
      p === '/api/panel/test-models' ||
      isRequestLogPath(p) ||
      LOG_STATS_GET.has(p))
  ) {
    return { ok: true, role: r }
  }
  if (r === 'super' && m === 'GET' && isSuperVmRead(p)) return { ok: true, role: r }
  if (r === 'super' && isSuperSchedule(m, p)) return { ok: true, role: r }

  return {
    ok: false,
    role: r,
    code: 'forbidden',
    message: '当前权限无法执行此操作',
  }
}

export function mePayload(req) {
  const ident = panelIdentity(req)
  return {
    user: ident.user,
    role: ident.role,
    views: viewsForRole(ident.role),
    capabilities: capabilitiesForRole(ident.role),
    vm_create_quota: Number(req?.panelVmCreateQuota) || 0,
  }
}
