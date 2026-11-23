import { usagePoolEnabled, usageRead } from '../lib/db/sqlite-pool.mjs'

const panelView = Symbol('panelQuotaView')

// findAccount/findRuntime are called for every VM. AccountQuota.snapshot also
// reads recent allocations for every account: repeat it once per HTTP response,
// never once per row. No cache crosses requests or reaches quota admission.
export function panelQuotaSnapshot(accountQuota) {
  if (!accountQuota?.snapshot || accountQuota[panelView]) return accountQuota
  const snapshot = accountQuota.snapshot()
  const view = Object.create(accountQuota)
  Object.defineProperties(view, {
    snapshot: { value: () => snapshot },
    [panelView]: { value: true },
  })
  return view
}

// Only a presentation snapshot: admission, accounting and quota writes never use it.
// Keep the existing ten-second billing TTL, with one cache shared by panel readers
// instead of four independent caches in the round-robin SQLite workers.
export function createPanelBillingReader({ enabled = usagePoolEnabled, read = usageRead, now = Date.now } = {}) {
  const scopes = new WeakMap()
  return async function readBilling(requestLog, accountWindows) {
    if (!requestLog?.billingStats) return null
    if (!enabled()) return requestLog.billingStats({ accountWindows })
    let cache = scopes.get(requestLog)
    if (!cache) scopes.set(requestLog, (cache = new Map()))
    const windows = (accountWindows || [])
      .map((w) => [w.account_id || '', w.vm_id || '', w.reset_5h || null, w.reset_7d || null, w.reset_7d_oi || null])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const key = JSON.stringify([Math.floor((now() + 8 * 3600_000) / 86400_000), windows])
    let entry = cache.get(key)
    if (!entry || (!entry.pending && entry.expiresAt <= now())) {
      entry = { pending: null, expiresAt: 0, value: null }
      cache.set(key, entry)
      if (cache.size > 32) cache.delete(cache.keys().next().value)
      entry.pending = Promise.resolve()
        .then(() =>
          read({
            kind: 'repo',
            method: 'billingStats',
            // Explicit now bypasses the repository's TTL: do not stack two caches.
            args: [{ accountWindows, now: now(), readOnly: true }],
          }),
        )
        .catch(() => {
          cache.delete(key)
          // Preserve the old response if the read pool is unavailable.
          return requestLog.billingStats({ accountWindows })
        })
        .then((value) => {
          entry.value = value
          entry.expiresAt = now() + 10_000
          entry.pending = null
          return value
        })
    }
    // Enrichment of one response must never mutate another role's cached view.
    return structuredClone(entry.pending ? await entry.pending : entry.value)
  }
}

export const readPanelBilling = createPanelBillingReader()
