import { normalizeOwnerId, vmOwnerId } from '../lib/admin/resource-owner.mjs'
import { applyScheduleOff } from '../lib/pool/schedule-state.mjs'

export const TENANT_PAUSE_REASON = 'tenant_paused'

/** Called with the current VM record immediately before persisting its scheduling fields. */
export function applyTenantVmSchedule(vm, ownerUserId, off) {
  const owner = normalizeOwnerId(ownerUserId)
  if (!owner || vmOwnerId(vm) !== owner) {
    throw Object.assign(new Error('vm not found'), { code: 'vm_not_found', status: 404 })
  }
  const tenantPaused = vm.schedule_off === true && vm.schedule_off_reason === TENANT_PAUSE_REASON
  if (vm.schedule_off === true && !tenantPaused) {
    if (off) return false
    throw Object.assign(new Error('管理员已关闭此 VM 的调度'), { code: 'schedule_operator_off', status: 409 })
  }
  if (off === tenantPaused) return false
  return applyScheduleOff(vm, off, { reason: TENANT_PAUSE_REASON, clearUnschedulable: false })
}
