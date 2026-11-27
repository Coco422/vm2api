import { vmHasSchedulableCredential } from '../lib/vm/vm-registry.mjs'

const RUNTIME_FAULTS = new Set(['kernel_faulted', 'worker_unhealthy', 'runtime_start_failed'])

export function tenantVmRecoveryBlock(vm, { projectRoot, proxy, availability }) {
  if (vm.schedule_off_reason === 'tenant_paused') return { code: 'tenant_paused', message: '请先解除自己的调度暂停' }
  if (vm.status !== 'running' || vm.schedule_off || vm.schedule_manual)
    return { code: 'operator_disabled', message: '仅运行中且未关闭调度的 VM 可以自助恢复' }
  if (vm.schedule_hold || vm.migration_pending || ['running', 'needs_attention'].includes(vm.slot_migration?.status))
    return { code: 'maintenance', message: 'VM 正在维护或迁移，请稍后再试' }
  const fault = vm.unschedulable?.reason || (vm.schedulable === false ? vm.schedule_disabled_reason : null)
  if ((vm.schedulable === false || fault) && !RUNTIME_FAULTS.has(fault))
    return { code: 'operator_required', message: '当前限制需要管理员处理' }
  if (!vmHasSchedulableCredential(vm, projectRoot) || ['bad', 'none'].includes(availability?.key))
    return { code: 'credential_unavailable', message: '账号凭证需要管理员处理' }
  if (!vm.proxy?.id || proxy?.id !== vm.proxy.id)
    return { code: 'egress_unavailable', message: '出口异常，请联系管理员' }
  if (availability?.key === 'quota')
    return { code: 'quota_restricted', message: '当前受额度限制，请主动查询额度或等待重置', until: availability.until }
  if (availability?.key === 'cool')
    return { code: 'cooldown_active', message: '当前仍在冷却，请等待到期后再检查', until: availability.until }
  if (availability?.key === 'rest')
    return { code: 'rest_period', message: '当前处于休息时段，请等待工作时段开始', until: availability.until }
  return null
}
