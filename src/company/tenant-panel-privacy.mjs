import path from 'node:path'
import { listVmRecordFiles, readJsonCached } from '../lib/vm/vm-file.mjs'

/** A tenant needs exit availability, never the purchased proxy's identity. */
export function tenantProxyView(proxy) {
  if (!proxy || typeof proxy !== 'object') return null
  return {
    configured: true,
    label: '已配置',
    status:
      proxy.blocked_reason || proxy.enabled === false
        ? 'dead'
        : ['unknown', 'ok', 'fail', 'dead', 'down', 'error'].includes(proxy.status)
          ? proxy.status
          : null,
    enabled: typeof proxy.enabled === 'boolean' ? proxy.enabled : null,
    blocked_reason: proxy.blocked_reason ? 'unavailable' : null,
    latency_ms: typeof proxy.latency_ms === 'number' ? proxy.latency_ms : null,
    consecutive_failures: typeof proxy.consecutive_failures === 'number' ? proxy.consecutive_failures : 0,
  }
}

/** Final JSON boundary: includes nested logs, filter names and credit-action responses. */
export function tenantPanelPayload(payload, { projectRoot, ownerUserId } = {}) {
  const vmIds = new Set()
  const privateText = new Set()
  if (projectRoot && ownerUserId) {
    const dir = path.join(projectRoot, 'vms')
    for (const file of listVmRecordFiles(dir)) {
      let vm
      try {
        vm = readJsonCached(path.join(dir, file))
      } catch {
        continue
      }
      if (vm?.owner_user_id !== ownerUserId) continue
      vmIds.add(vm.id)
      const p = vm.proxy || {}
      for (const value of [p.id, p.host, p.url, p.username, p.password]) {
        if (typeof value === 'string' && value.length >= 4) privateText.add(value)
      }
    }
  }
  for (const id of vmIds) privateText.delete(id)
  const patterns = [...privateText]
    .sort((a, b) => b.length - a.length)
    .map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))
  const text = (value) => {
    // URI credentials can be escaped differently from the stored username/password.
    let out = value
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*@[^\s"'<>]+/gi, '[连接信息已隐藏]')
      .replace(/socks5h?:\/\/[^\s"'<>]+/gi, '[出口信息已隐藏]')
    for (const pattern of patterns) out = out.replace(pattern, '[出口信息已隐藏]')
    return out
  }
  const visit = (value) => {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object') return value
    if (value instanceof Date) return value
    const vm = vmIds.has(value.id) || ('proxy_configured' in value && typeof value.id === 'string')
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'proxy') out[key] = tenantProxyView(item)
      else if (key === 'proxy_pool' || key === 'proxies') out[key] = null
      else if (/^proxy[_A-Z]/.test(key) && !['proxy_configured', 'proxy_cli_enabled'].includes(key)) out[key] = null
      else if (vm && key === 'name') out[key] = value.id
      else if (vm && key === 'note') out[key] = null
      else if (key === 'vmName' || key === 'vm_name') out[key] = value.vmId || value.vm_id || null
      else out[key] = visit(item)
    }
    return out
  }
  return visit(payload)
}
