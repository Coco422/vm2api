import { SettingsRepo } from '../lib/db/repos/settings-repo.mjs'
import { VM_DELIVERY_BATCHES } from './vm-delivery-history.mjs'

const DAY_MS = 86_400_000
const SHUTDOWNS_KEY = 'company_vm_delivery_shutdowns'
const DELIVERIES_KEY = 'company_vm_deliveries'
const MEMBERS = new Map(
  VM_DELIVERY_BATCHES.flatMap(({ name, members }) =>
    members.map((record) => [record.vmId, { ...record, batch: name }]),
  ),
)

function historicalMember(vm) {
  const member = MEMBERS.get(vm?.id)
  // A newly created slot reusing an old identifier has its own lifecycle.
  if (!member || Date.parse(vm.created_at) > Date.parse(member.firstSuccessAt)) return null
  return member
}

function deliveryKey(vm) {
  const created = Date.parse(vm?.created_at)
  return vm?.id && Number.isFinite(created) ? `${vm.id}:${new Date(created).toISOString()}` : null
}

export function prepareVmDelivery(vm, value, db) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(value)) {
    return { error: '交付批次须为 1–40 个字符', status: 400 }
  }
  const key = deliveryKey(vm)
  if (!key) return { error: '缺少 VM 创建时间，无法登记交付', status: 400 }
  const batch = value.trim()
  const settings = new SettingsRepo(db)
  const deliveries = settings.get(DELIVERIES_KEY) || {}
  const current = historicalMember(vm) || deliveries[key]
  if (current && current.batch !== batch) return { error: '此 VM 已登记在其他交付批次', status: 409 }
  return {
    save() {
      if (current) return
      const createdAt = new Date(Date.parse(vm.created_at)).toISOString()
      settings.set(DELIVERIES_KEY, { ...deliveries, [key]: { vmId: vm.id, createdAt, batch } })
    },
  }
}

function liveLifecycle(db, member) {
  const end = member.shutdownAt || '9999-12-31T23:59:59.999Z'
  const first = db
    .prepare(
      `SELECT MIN(created_at) AS at FROM usage_logs
     WHERE vm_id = ? AND created_at >= ? AND created_at <= ?
       AND status BETWEEN 200 AND 299 AND final_state = 'verified'`,
    )
    .get(member.vmId, member.createdAt, end).at
  return lifecycle({ ...member, firstSuccessAt: first ?? null })
}

function lifecycle(member, recordedAt) {
  const first = Date.parse(member.firstSuccessAt)
  const stop = member.shutdownAt || recordedAt
  const elapsed = Date.parse(stop) - first
  return {
    batch: member.batch,
    firstSuccessAt: member.firstSuccessAt,
    shutdownAt: elapsed >= 0 ? stop : null,
    confirmedStoppedBy: member.confirmedStoppedBy || null,
    survivalDays: elapsed >= 0 ? elapsed / DAY_MS : null,
  }
}

/** Call only after the native stop operation and VM state write have succeeded. */
export function recordDeliveryShutdown(vm, getDb) {
  const at = vm.schedule_updated_at
  if (vm.status !== 'stopped' || vm.schedule_off_reason !== 'stopped' || !Number.isFinite(Date.parse(at))) return
  const settings = new SettingsRepo(getDb())
  const member = historicalMember(vm)
  if (!member) {
    const key = deliveryKey(vm)
    const deliveries = settings.get(DELIVERIES_KEY) || {}
    const delivery = key && deliveries[key]
    if (delivery && !delivery.shutdownAt && Date.parse(at) >= Date.parse(delivery.createdAt)) {
      settings.set(DELIVERIES_KEY, { ...deliveries, [key]: { ...delivery, shutdownAt: at } })
    }
    return
  }
  if (member.shutdownAt || member.confirmedStoppedBy || Date.parse(at) < Date.parse(member.firstSuccessAt)) return
  const recorded = settings.get(SHUTDOWNS_KEY) || {}
  if (!recorded[member.vmId]) settings.set(SHUTDOWNS_KEY, { ...recorded, [member.vmId]: at })
}

/** Caller has already applied the VM detail route's role and ownership guard. */
export function vmDeliveryLifecycle(vm, getDb) {
  const key = deliveryKey(vm)
  const member = historicalMember(vm)
  if (!key && !member) return null
  const db = getDb()
  const settings = new SettingsRepo(db)
  if (member) return lifecycle(member, settings.get(SHUTDOWNS_KEY)?.[member.vmId])
  const registered = settings.get(DELIVERIES_KEY)?.[key]
  return registered ? liveLifecycle(db, registered) : null
}

function median(values) {
  if (!values.length) return null
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return (values[Math.floor((values.length - 1) / 2)] + values[middle]) / 2
}

export function vmDeliveryBatchStatistics(db) {
  const settings = new SettingsRepo(db)
  const recorded = settings.get(SHUTDOWNS_KEY)
  const batches = new Map(
    VM_DELIVERY_BATCHES.map(({ name, members }) => [
      name,
      members.map((member) => lifecycle(member, recorded?.[member.vmId])),
    ]),
  )
  for (const member of Object.values(settings.get(DELIVERIES_KEY) || {})) {
    if (!batches.has(member.batch)) batches.set(member.batch, [])
    const record = liveLifecycle(db, member)
    if (record.firstSuccessAt) batches.get(member.batch).push(record)
  }
  return [...batches].map(([name, records]) => {
    const stopped = records.filter((record) => record.shutdownAt || record.confirmedStoppedBy)
    // An unknown shutdown time can still leave the median fixed. Check both
    // ends of its possible duration without using the verification time as a stop.
    const lower = median(stopped.map((record) => record.survivalDays ?? 0))
    const upper = median(
      stopped.map(
        (record) =>
          record.survivalDays ?? (Date.parse(record.confirmedStoppedBy) - Date.parse(record.firstSuccessAt)) / DAY_MS,
      ),
    )
    return {
      batch: name,
      started: records.length,
      active: records.length - stopped.length,
      stopped: stopped.length,
      medianSurvivalDays: lower === upper ? lower : null,
    }
  })
}
