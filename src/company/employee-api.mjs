/** Optional company API. No panel sessions, master-key access, credential export or configuration writes. */
import { extractApiKey } from '../lib/core/security.mjs'
import { keyAllowsVm, keyScopeFromRequest } from '../lib/admin/key-scope.mjs'
import { vmOwnerId } from '../lib/admin/resource-owner.mjs'
import { listVms } from '../lib/vm/vm-registry.mjs'
import { isCodexVm } from '../lib/vm/vm-kind.mjs'
import {
  findAccount,
  quotaFromAccount,
  buildProbeOne,
  buildOpenaiQuotaRefresh,
  buildOpenaiQuotaReset,
  buildClaudeResetQuery,
  buildClaudeResetRedeem,
} from '../lib/admin/panel-api.mjs'
import { employeeUsage, employeeDayRequests } from './employee-usage.mjs'
import { redeemEmployeeOpenai } from './employee-reset.mjs'

function limiter(capacity, interval, maxEntries = 2048) {
  const buckets = new Map()
  return (key) => {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket || now - bucket.at >= interval) {
      buckets.delete(key)
      if (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value)
      bucket = { at: now, count: 0 }
      buckets.set(key, bucket)
    }
    return ++bucket.count <= capacity
  }
}

function keyView(rec, gate) {
  return {
    name: String(rec.name || ''),
    status: rec.status,
    expires_at: rec.expires_at || null,
    inference_allowed: gate.ok,
    inference_error: gate.ok ? null : gate.code,
    quota_usd: Number(rec.quota) || 0,
    quota_usd_used: Number(rec.quota_used) || 0,
    quota_requests: Number(rec.quota_requests) || 0,
    quota_requests_used: Number(rec.quota_requests_used) || 0,
    windows: ['5h', '1d', '7d'].map((window) => ({
      window,
      limit_usd: Number(rec[`rate_limit_${window}`]) || 0,
      used_usd: Number(rec[`usage_${window}`]) || 0,
      started_at: rec[`window_${window}_start`] || null,
    })),
  }
}

function vmView(vm, accountQuota) {
  const quota = isCodexVm(vm)
    ? vm.codex_usage?.quota || {}
    : quotaFromAccount(findAccount(accountQuota, vm), accountQuota?.config)
  const window = (suffix) => {
    const value = quota[`utilization_${suffix}`]
    return {
      used_percent:
        value == null || !Number.isFinite(Number(value)) ? null : Math.min(100, Math.max(0, Number(value) * 100)),
      resets_at: quota[`reset_${suffix}`] || null,
    }
  }
  return {
    id: vm.id,
    name: String(vm.name || vm.label || vm.id),
    platform: isCodexVm(vm) ? 'openai' : 'anthropic',
    tier: String(vm.account_tier || quota.account_tier || ''),
    schedulable: vm.schedulable !== false,
    credential_ready: vm.has_token === true,
    quota: { five_hour: window('5h'), seven_day: window('7d') },
    quota_sampled_at: quota.last_probe?.at || quota.last_probe?.ts || null,
    reset_supported: isCodexVm(vm) || vm.can_claude_reset === true,
  }
}

export function createEmployeeHandler({
  enabled = false,
  cfg,
  apiKeyStore,
  accountQuota,
  getRoutingConfig = () => ({}),
  json,
  readBody,
  isRestoring = () => false,
  operations = {
    buildProbeOne,
    buildOpenaiQuotaRefresh,
    buildOpenaiQuotaReset,
    buildClaudeResetQuery,
    buildClaudeResetRedeem,
  },
  usage = employeeUsage,
} = {}) {
  const allowIp = limiter(120, 60_000)
  const allowKey = limiter(120, 60_000)
  const allowOperation = limiter(6, 60_000)
  const busy = new Set()
  const error = (res, status, code, message) => json(res, status, { ok: false, error: { code, message } })

  return async function handleEmployee(req, res, url) {
    const p = url.pathname
    if (p !== '/api/company' && !p.startsWith('/api/company/')) return false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (!enabled) return error(res, 404, 'not_found', '员工入口未启用')
    if (isRestoring()) return error(res, 503, 'restore_in_progress', '服务维护中，请稍后重试')
    if (!allowIp(req.socket?.remoteAddress || 'unknown'))
      return error(res, 429, 'rate_limited', '查询过于频繁，请稍后再试')
    // Bearer token only, never cookies, URL query keys or the panel's master identity.
    const token = extractApiKey(req)
    if (!token || token.length > 256) return error(res, 401, 'invalid_employee_key', '请输入有效的员工 Key')
    const authed = apiKeyStore.authenticate(token)
    if (!authed.ok) return error(res, 401, 'invalid_employee_key', 'Key 无效或已撤销')
    const rec = authed.record
    const owner = rec.user_id ? apiKeyStore.users.getById(rec.user_id) : null
    if (
      !owner ||
      owner.role !== 'user' ||
      owner.status !== 'active' ||
      rec.category === 'api' ||
      !['active', 'quota_exhausted'].includes(rec.status) ||
      (rec.expires_at && !(Date.parse(rec.expires_at) > Date.now()))
    ) {
      return error(res, 403, 'employee_access_denied', 'Key 未授权员工访问、已停用或已过期')
    }
    if (!allowKey(rec.id)) return error(res, 429, 'rate_limited', '查询过于频繁，请稍后再试')
    const scope = keyScopeFromRequest({ apiKeyKind: 'managed', apiKeyRecord: rec })
    const vms = listVms(cfg.paths.project).filter((vm) => vmOwnerId(vm) === rec.user_id && keyAllowsVm(scope, vm))
    if (req.method === 'GET' && p === '/api/company/me') {
      return json(res, 200, {
        ok: true,
        data: {
          employee: { name: owner.username },
          key: keyView(rec, apiKeyStore.canAccept(rec)),
          vms: vms.map((vm) => vmView(vm, accountQuota)),
        },
      })
    }
    if (req.method === 'GET' && p === '/api/company/usage') {
      const days = Number(url.searchParams.get('days') || 30)
      if (![7, 30, 90].includes(days)) return error(res, 400, 'invalid_days', '统计范围只能是 7、30 或 90 天')
      return json(res, 200, { ok: true, data: usage(apiKeyStore.db, { keyId: rec.id, userId: rec.user_id, days }) })
    }
    if (req.method === 'GET' && p === '/api/company/requests') {
      const page = url.searchParams.get('page') || '1'
      const pageSize = url.searchParams.get('page_size') || '20'
      if (!/^[1-9]\d*$/.test(page) || !/^[1-9]\d*$/.test(pageSize))
        return error(res, 400, 'invalid_request_query', '日期或分页参数无效')
      try {
        return json(res, 200, {
          ok: true,
          data: employeeDayRequests(apiKeyStore.db, {
            keyId: rec.id,
            userId: rec.user_id,
            day: url.searchParams.get('day'),
            page: Number(page),
            pageSize: Number(pageSize),
            snapshot: url.searchParams.get('snapshot'),
          }),
        })
      } catch (err) {
        if (err.code === 'invalid_request_query') return error(res, 400, err.code, '请提供有效的日期与分页参数')
        throw err
      }
    }
    const match = p.match(/^\/api\/company\/vms\/([^/]+)\/(refresh|reset-query|reset-redeem)$/)
    if (!match || req.method !== 'POST') return error(res, 404, 'not_found', '接口不存在')
    const vm = vms.find((item) => item.id === match[1])
    if (!vm) return error(res, 404, 'vm_not_found', '虚拟机不存在')
    // Never pass employee body fields to privileged upstream functions.
    if (req.headers.origin) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(req.headers.origin).host === req.headers.host
      } catch {}
      if (!sameOrigin) return error(res, 403, 'origin_denied', '请从员工页面发起操作')
    }
    if (
      !String(req.headers['content-type'] || '')
        .toLowerCase()
        .startsWith('application/json')
    )
      return error(res, 415, 'json_required', '请发送 JSON 请求')
    let body
    try {
      body = await readBody(req, 1024)
    } catch {
      return error(res, 400, 'invalid_body', '请求格式无效')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      return error(res, 400, 'invalid_body', '此操作不接受配置参数')
    // Reading a slow request body yields to admin changes. Recheck before any upstream write.
    const live = apiKeyStore.authenticate(token)
    const liveOwner = live.ok ? apiKeyStore.users.getById(live.record.user_id) : null
    if (
      !live.ok ||
      live.record.user_id !== rec.user_id ||
      live.record.category === 'api' ||
      !['active', 'quota_exhausted'].includes(live.record.status) ||
      (live.record.expires_at && !(Date.parse(live.record.expires_at) > Date.now())) ||
      !liveOwner ||
      liveOwner.role !== 'user' ||
      liveOwner.status !== 'active'
    )
      return error(res, 403, 'employee_access_denied', 'Key 授权已变更，请重新进入')
    const liveScope = keyScopeFromRequest({ apiKeyKind: 'managed', apiKeyRecord: live.record })
    if (
      !listVms(cfg.paths.project).some(
        (item) => item.id === vm.id && vmOwnerId(item) === live.record.user_id && keyAllowsVm(liveScope, item),
      )
    )
      return error(res, 404, 'vm_not_found', '虚拟机不存在')
    if (isRestoring()) return error(res, 503, 'restore_in_progress', '服务维护中，请稍后重试')
    const action = match[2]
    if (!allowOperation(`${rec.id}:${vm.id}`))
      return error(res, 429, 'operation_rate_limited', '操作过于频繁，请稍后再试')
    if (busy.has(vm.id)) return error(res, 409, 'operation_busy', '该虚拟机已有操作正在进行')
    const args = { cfg, id: vm.id, accountQuota, routingConfig: getRoutingConfig() }
    const gpt = isCodexVm(vm)
    if (action === 'reset-redeem' && !/^[A-Za-z0-9._:-]{8,128}$/.test(String(req.headers['idempotency-key'] || '')))
      return error(res, 400, 'idempotency_required', '重置操作缺少有效的幂等标识')
    busy.add(vm.id)
    try {
      let result
      if (action === 'refresh')
        result = await (gpt ? operations.buildOpenaiQuotaRefresh : operations.buildProbeOne)({
          ...args,
          hop: true,
          force: true,
        })
      else if (action === 'reset-query')
        result = await (gpt ? operations.buildOpenaiQuotaRefresh : operations.buildClaudeResetQuery)(args)
      else if (gpt)
        result = await redeemEmployeeOpenai({
          db: apiKeyStore.db,
          vmId: vm.id,
          operationId: req.headers['idempotency-key'],
          run: () => operations.buildOpenaiQuotaReset(args),
        })
      else result = await operations.buildClaudeResetRedeem({ ...args, idempotencyKey: req.headers['idempotency-key'] })
      if (result.status || result.ok === false)
        return error(res, result.status || 502, 'upstream_operation_failed', '上游未完成此操作，请查询状态后重试')
      const data = result.data || result
      // Explicit response allowlist: no credential, proxy, raw account or upstream error payload.
      return json(res, 200, {
        ok: true,
        data: {
          outcome: typeof data.outcome === 'string' ? data.outcome : null,
          warning: data.warning === 'reset_credit_cache_refresh_failed' ? data.warning : null,
          reset_credits: publicCredits(data.claude_reset_credits || data.reset_credits),
        },
      })
    } catch {
      return error(res, 502, 'operation_unconfirmed', '操作结果未确认，请先查询状态；不要连续兑换')
    } finally {
      busy.delete(vm.id)
    }
  }
}

export function publicCredits(value) {
  if (!value) return null
  return {
    available_count: Math.max(0, Number(value.available_count) || 0),
    fetched_at: value.fetched_at || null,
    credits: (Array.isArray(value.credits) ? value.credits : []).map((credit) => ({
      label: String(credit.label || ''),
      resets_left: Number(credit.resets_left) || 0,
      expires_at: credit.expires_at || null,
      redeemable: credit.redeemable === true,
    })),
  }
}
