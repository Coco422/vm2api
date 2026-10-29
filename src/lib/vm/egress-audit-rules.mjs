import { isIP } from 'node:net'

export const AUDIT_SITES = Object.freeze([
  { id: 'net-coffee', url: 'https://ip.net.coffee/claude/' },
  { id: 'ping0', url: 'https://ping0.cc/' },
  { id: 'fuck-claude', url: 'https://fuck-claude.com/' },
])

export const AUDIT_EVIDENCE = Object.freeze([
  { id: 'net-coffee', site: 'net-coffee', field: 'screenshot' },
  { id: 'net-coffee-leaks', site: 'net-coffee', field: 'leaks_screenshot' },
  { id: 'ping0', site: 'ping0', field: 'screenshot' },
  { id: 'fuck-claude', site: 'fuck-claude', field: 'screenshot' },
])

export const AUDIT_CRITERIA = Object.freeze([
  { id: 'trust', site: 'net-coffee', label: 'Claude 信任评分', rule: '≥ 90 分' },
  { id: 'leaks', site: 'net-coffee', label: 'DNS / WebRTC', rule: '两项全绿、无泄露且有观测结果' },
  { id: 'purity', site: 'ping0', label: '纯净度 / AI 适用性', rule: '两项均为绿色' },
  { id: 'environment', site: 'fuck-claude', label: '环境风险评分', rule: '< 30 分' },
])

function score(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  if (!/^\d{1,3}(?:\.\d+)?(?:\s|$)/.test(text)) return null
  const n = Number.parseFloat(text)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null
}

const observedIp = (values) => Array.isArray(values) && values.some((ip) => isIP(String(ip).trim()))

function leakVerdict(item) {
  if (!item?.complete) return 'unknown'
  if (item.warning === true) return 'fail'
  // These sites can paint failed/disabled probes green. Require actual observations.
  if (item.green !== true || !observedIp(item.ips)) return 'unknown'
  return 'pass'
}

export function evaluateAudit(observations = {}) {
  const net = observations['net-coffee'] || {}
  const ping = observations.ping0 || {}
  const env = observations['fuck-claude'] || {}
  const trust = net.complete === true && isIP(String(net.ip || '').trim()) ? score(net.score) : null
  const risk = env.complete === true ? score(env.score) : null
  const dns = leakVerdict(net.dns)
  const udp =
    net.webrtc?.complete &&
    observedIp(net.webrtc.ips) &&
    isIP(String(net.ip || '')) &&
    net.webrtc.ips.some((ip) => isIP(String(ip)) && ip !== net.ip)
      ? 'fail'
      : leakVerdict(net.webrtc)
  const leaks = dns === 'fail' || udp === 'fail' ? 'fail' : dns === 'pass' && udp === 'pass' ? 'pass' : 'unknown'
  const pingReady = ping.complete === true && isIP(String(ping.ip || '').trim())
  const purity =
    !pingReady || typeof ping.purity_green !== 'boolean' || typeof ping.ai_green !== 'boolean'
      ? 'unknown'
      : ping.purity_green && ping.ai_green
        ? 'pass'
        : 'fail'
  const probeLabel = { pass: '通过', fail: '泄露', unknown: '未确认' }
  const results = [
    { ...AUDIT_CRITERIA[0], status: trust == null ? 'unknown' : trust >= 90 ? 'pass' : 'fail', value: trust },
    { ...AUDIT_CRITERIA[1], status: leaks, value: `DNS: ${probeLabel[dns]} / WebRTC: ${probeLabel[udp]}` },
    {
      ...AUDIT_CRITERIA[2],
      status: purity,
      value: pingReady ? `纯净度: ${ping.purity_text || '—'} / AI: ${ping.ai_text || '—'}` : null,
    },
    { ...AUDIT_CRITERIA[3], status: risk == null ? 'unknown' : risk < 30 ? 'pass' : 'fail', value: risk },
  ]
  // Domain-based routing may use different exits. Never certify that as one VM exit.
  const ips = [net.ip, ping.ip].filter((ip) => isIP(String(ip || '').trim()))
  const exitConsistent = ips.length === 2 ? ips[0] === ips[1] : null
  return {
    results,
    exit_consistent: exitConsistent,
    status:
      exitConsistent === false || results.some((r) => r.status === 'fail')
        ? 'fail'
        : results.every((r) => r.status === 'pass')
          ? 'pass'
          : 'unknown',
  }
}
