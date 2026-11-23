import { parseVmQuotaOverride } from '../lib/pool/vm-quota-override.mjs'

export function mergeTenantVmQuotaThresholds(current, body) {
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []
  if (!keys.length || keys.some((key) => !['limit_5h', 'limit_7d', 'block_on_5h', 'block_on_7d'].includes(key))) {
    return { ok: false, error: '只允许设置 5h/7d 闸线或开启对应闸线' }
  }
  if (keys.some((key) => key.startsWith('block_on_') && body[key] !== true)) {
    return { ok: false, error: '普通用户只能开启闸线' }
  }
  const parsed = parseVmQuotaOverride(body)
  if (!parsed.ok) return parsed

  const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
  for (const key of keys) {
    const value = parsed.value?.[key]
    if (value == null) {
      delete next[key]
      continue
    }
    next[key] = value
    const window = key.slice(-2)
    next[`block_on_${window}`] = true
    next[`tenant_exact_${window}`] = true
  }
  return { ok: true, value: Object.keys(next).length ? next : null }
}
