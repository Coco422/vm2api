import { vmGroupType } from '../lib/admin/key-scope.mjs'
import { normalizeOwnerId, vmOwnerId } from '../lib/admin/resource-owner.mjs'

function denied(message, code = 'tenant_key_fields_forbidden') {
  throw Object.assign(new Error(message), { code, status: 403 })
}

/** Self-service changes credentials, never administrator-controlled limits. */
export function tenantKeyInput(body, { create = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('请发送 JSON 对象'), { code: 'invalid_key_request', status: 400 })
  }
  const allowed = create ? ['name'] : ['name', 'status']
  if (Object.keys(body).some((key) => !allowed.includes(key))) denied('密钥额度、并发和资源范围由管理员设置')
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100)) {
    throw Object.assign(new Error('密钥名称须为1至100个字符'), { code: 'invalid_key_name', status: 400 })
  }
  if ('status' in body && !['active', 'disabled'].includes(body.status)) {
    throw Object.assign(new Error('密钥状态无效'), { code: 'invalid_status', status: 400 })
  }
  return { ...body, ...('name' in body ? { name: body.name.trim() } : {}) }
}

/** Keys label clients using the tenant's existing VM grant; they are not new account budgets. */
export function tenantKeyCreateInput({ body, ownerId, store, vms, defaultConcurrency }) {
  const input = tenantKeyInput(body, { create: true })
  const owner = ownerId ? store.users.getById(ownerId) : null
  if (!owner || owner.status !== 'active') denied('当前用户不可创建密钥', 'tenant_key_owner_disabled')
  const owned = vms.filter((vm) => vmOwnerId(vm) === normalizeOwnerId(ownerId))
  if (!owned.length) denied('请先由管理员分配可调用的 VM', 'tenant_key_vm_required')
  const groups = new Set(owned.map(vmGroupType))
  const ownerCap = Number(owner.concurrency)
  const fallback = Number(defaultConcurrency)
  return {
    ...input,
    category: 'oauth',
    user_id: ownerId,
    group_id: 1,
    // An administrator's explicit user grant overrides the new-key default.
    // All client keys still share ApiKeyStore's cumulative user gate.
    max_concurrency:
      Number.isFinite(ownerCap) && ownerCap > 0 ? ownerCap : Number.isFinite(fallback) && fallback > 0 ? fallback : 12,
    group_type: groups.size === 1 ? [...groups][0] : 'all',
    allowed_vms: groups.size === 1 ? owned.map((vm) => vm.id) : [],
  }
}
