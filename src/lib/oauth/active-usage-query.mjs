import path from 'node:path'
import { canOfficialUsage, credentialModeOfVm } from './credential-mode.mjs'
import {
  probeVmUsage,
  isOfficialUsageRateLimited,
  usageErrorText,
  usageProbeBackoffRemainingMs,
} from './crs-usage-probe.mjs'
import { getUsageCache } from './usage-cache.mjs'
import { getVm, isCodexVm, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { normalizeOwnerId, vmOwnerId } from '../admin/resource-owner.mjs'
import { readConfirmedClaudeReset } from './claude-reset-credits.mjs'

function failure(status, code, message) {
  return { status, body: { ok: false, error: { code, message } } }
}

/** Explicit user action: fresh official usage, no model request or cached-success fallback. */
export function createActiveUsageQuery({ probe = probeVmUsage } = {}) {
  const flights = new Map()
  return async function query({ projectRoot, vm, accountQuota, poolScheduler, confirmedReset = null, tenantUserId }) {
    const tenant = tenantUserId !== undefined
    const owner = normalizeOwnerId(tenantUserId)
    const canRefresh = (slot) => !!slot && (!tenant || (!!owner && vmOwnerId(slot) === owner))
    const matchesAccount = (slot) =>
      !!slot && slot.claude?.account_uuid === vm.claude?.account_uuid && slot.claude?.org_uuid === vm.claude?.org_uuid
    if (!canRefresh(vm)) return failure(404, 'vm_not_found', '槽位不存在')
    if (isCodexVm(vm)) return failure(400, 'unsupported_platform', '请使用 GPT 额度查询')
    if (!vmHasClaudeCredential(vm)) return failure(400, 'no_oauth_token', '请先导入账号凭证')
    if (!canOfficialUsage(credentialModeOfVm(vm))) {
      return failure(400, 'usage_scope_required', '当前凭证不支持官方额度查询，请导入完整 OAuth')
    }
    const accountId = vm.claude?.account_uuid || vm.id
    const key = JSON.stringify([projectRoot, vm.id, accountId, owner])
    const reset = confirmedReset || readConfirmedClaudeReset(projectRoot, vm)
    const previous = flights.get(key)
    if (previous && (!reset || previous.resetAt === reset.at)) return await previous.pending
    const pending = (async () => {
      if (previous) await previous.pending.catch(() => {})
      if (tenant && !canRefresh(getVm(projectRoot, vm.id))) return failure(404, 'vm_not_found', '槽位不存在')
      const account = await accountQuota.ensure({ account_id: accountId, vm_id: vm.id })
      const backoff = usageProbeBackoffRemainingMs(account.unified)
      if (backoff > 0) {
        return failure(429, 'usage_rate_limited', `官方额度查询限流，请约 ${Math.ceil(backoff / 1000)} 秒后重试`)
      }
      if (tenant) {
        const current = getVm(projectRoot, vm.id)
        if (!canRefresh(current)) return failure(404, 'vm_not_found', '槽位不存在')
        if (!matchesAccount(current)) return failure(409, 'usage_account_changed', '槽位账号已变更，请重新查询额度')
      }
      const exec = { vmId: vm.id, homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'), oauth: vm.claude, vm }
      let result
      try {
        result = await probe({ exec, vm, includeFable: false, timeoutMs: 30_000 })
      } catch {
        return failure(502, 'usage_query_failed', '官方额度查询失败，请稍后重试')
      }
      const current = tenant || reset || poolScheduler ? getVm(projectRoot, vm.id) : vm
      if (tenant && !canRefresh(current)) return failure(404, 'vm_not_found', '槽位不存在')
      if (!matchesAccount(current)) {
        return failure(409, 'usage_account_changed', '槽位账号已变更，请重新查询额度')
      }
      if (isOfficialUsageRateLimited(result)) {
        await accountQuota.ingestOAuthUsage(accountId, result)
        return failure(429, 'usage_rate_limited', '官方额度查询限流，请稍后重试')
      }
      if (!result.ok || !('usage_status' in result) || result.usage_status !== 200 || result.limits_present !== true) {
        const message =
          'usage_scope_missing' in result && result.usage_scope_missing
            ? '当前凭证缺少额度查询权限，请重新导入完整 OAuth'
            : (!tenant && usageErrorText(result)) || '官方接口未返回完整额度数据'
        return failure(502, 'usage_query_failed', message)
      }
      const resetContext = reset && { ...reset, protectNewerSamples: !!confirmedReset }
      const saved = await accountQuota.ingestOAuthUsage(accountId, result, { confirmedReset: resetContext })
      getUsageCache().clear(accountId)
      if (poolScheduler) {
        poolScheduler.syncQuotaSchedule(current, saved)
        poolScheduler.signalChange()
        poolScheduler.notifyCapacity()
      }
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            vm_id: vm.id,
            source: 'official-cc-usage',
            probed_at: result.probed_at,
            five_hour: result.five_hour,
            seven_day: result.seven_day,
            seven_day_oi: result.seven_day_oi,
          },
        },
      }
    })()
    const flight = { pending, resetAt: reset?.at }
    flights.set(key, flight)
    try {
      return await pending
    } finally {
      if (flights.get(key) === flight) flights.delete(key)
    }
  }
}

export const queryActiveUsage = createActiveUsageQuery()
