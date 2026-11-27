import { isDeepStrictEqual } from 'node:util'
import { inspectWrapUpdateTopology } from '../cluster/remote-slot.mjs'
import { pushKernelSelection } from '../cluster/remote-slot-files.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import { restartRustKernel, wrapHopInflight } from '../transport/rust-kernel-supervisor.mjs'
import { slotExec } from './slot-runtime.mjs'
import { withSlotMaintenance } from './slot-maintenance.mjs'
import { getVm, markUnschedulable } from './vm-registry.mjs'

export async function updateSlotKernel({ project, vm, routing, watchdog, poolScheduler }, ops = {}) {
  const fail = (code) => ({ id: vm.id, ok: false, code })
  if (!poolScheduler?.vmInflight || !watchdog?.hold || !watchdog?.release) return fail('kernel_lifecycle_unavailable')
  const inspect = ops.inspect || inspectWrapUpdateTopology
  let writing = false
  try {
    const before = await inspect(vm, routing)
    const apply = async () => {
      const current = (ops.current || getVm)(project, vm.id)
      if (!current || !isDeepStrictEqual(before, await inspect(current, routing))) return fail('slot_update_superseded')
      const exec = slotExec(project, current)
      if (before.running) {
        const health = await (ops.health || rustKernelHealth)(exec)
        const total = before.slots
        if (
          !health?.ok ||
          health.recovering ||
          health.healthy === false ||
          !Number.isInteger(health.ready_slots) ||
          !Number.isInteger(health.closed_slots) ||
          health.ready_slots + health.closed_slots !== total ||
          ['active', 'active_requests', 'waiting', 'queued', 'cleaning'].some(
            (k) => health[k] != null && health[k] !== 0,
          ) ||
          wrapHopInflight(exec) ||
          poolScheduler.vmInflight.get(vm.id)
        )
          return fail('slot_update_busy')
      }
      writing = true
      const published = await (ops.publish || pushKernelSelection)(current, project, 'cli-node')
      if (!published?.ok) throw new Error('slot_payload_publish_failed')
      const kernel = before.running
        ? await (ops.restart || restartRustKernel)(exec)
        : { ok: true, skipped: true, reason: 'vm_stopped' }
      if (!kernel?.ok) throw new Error('kernel_restart_failed')
      if (!isDeepStrictEqual(before, await inspect(current, routing))) throw new Error('slot_update_topology_changed')
      return { id: vm.id, ok: true, kernel_changed: !!published.wrap?.pushed, restarted: before.running, kernel }
    }
    if (!before.running) return await apply()
    const result = await (ops.maintenance || withSlotMaintenance)({
      projectRoot: project,
      id: vm.id,
      watchdog,
      poolScheduler,
      operation: async () => {
        try {
          return await apply()
        } catch (error) {
          if (writing)
            (ops.block || markUnschedulable)(project, vm.id, 'runtime_start_failed', { code: 'slot_update_incomplete' })
          throw error
        }
      },
    })
    return { ...result, id: vm.id }
  } catch (error) {
    const code = [
      'slot_update_topology_unsupported',
      'slot_payload_publish_failed',
      'kernel_restart_failed',
      'slot_update_topology_changed',
    ].includes(error.message)
      ? error.message
      : 'slot_update_failed'
    return fail(code)
  }
}
