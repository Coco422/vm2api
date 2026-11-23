/**
 * Live credential view for the panel.
 * Go worker is the refresh owner; vm.json / SQLite runtime can lag for hours
 * on idle slots. Dashboard/list/detail read the slot file + /internal/health
 * and never send tokens to the console.
 */
import { expiresAtToMs, mirrorWorkerCredentialsToVm, readSlotCredentialIdentity } from '../oauth/oauth-credentials.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import { vmJsonPath } from '../vm/execution-context.mjs'
import { slotExec } from '../vm/slot-runtime.mjs'
import { CREDENTIAL_REFRESH_FAIL } from '../pool/availability.mjs'
import fs from 'node:fs'

export const LIVE_CREDENTIAL_SKEW_MS = 5 * 60 * 1000
export const LIVE_CREDENTIAL_CACHE_MS = 3000
const MIRROR_NEWER_MS = 2000

const cache = new Map()
let generation = 0

export function invalidateLiveCredentialCache() {
  generation += 1
  cache.clear()
}

function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const n = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1))
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  }
  return Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, () => worker())).then(() => out)
}

function healthUsable(health) {
  return !!(
    health &&
    !health.transportError &&
    health.code !== 'worker_unavailable' &&
    (health.credential || health.ok === true)
  )
}

export function publicLiveCredential(health = null, fileIdentity = null, now = Date.now()) {
  const cred = healthUsable(health) ? health.credential || {} : {}
  const fileMs = expiresAtToMs(fileIdentity?.expires_at)
  const healthMs = expiresAtToMs(cred.expires_at)
  const expMs = Math.max(fileMs, healthMs)
  const hasAccess = !!(cred.has_access || fileIdentity?.has_access)
  const hasRefresh = !!(cred.has_refresh || fileIdentity?.has_refresh)
  const ttlSeconds = expMs
    ? Math.round((expMs - now) / 1000)
    : Number.isFinite(Number(cred.ttl_seconds))
      ? Number(cred.ttl_seconds)
      : null
  const needsRefresh = expMs ? expMs - now <= LIVE_CREDENTIAL_SKEW_MS : !!cred.needs_refresh
  let state = 'missing'
  if (hasRefresh && !hasAccess) state = 'refreshable'
  else if (expMs && expMs <= now) state = hasRefresh ? 'expired_refreshable' : 'expired'
  else if (needsRefresh && hasAccess) state = 'refresh_window'
  else if (hasAccess) state = 'fresh'
  const liveHealth = healthUsable(health)
  let lastError = liveHealth
    ? health.last_error || (typeof health.error === 'string' ? health.error : health.error?.message) || null
    : null
  let lastErrorClass = liveHealth ? health.last_error_class || null : null
  // A successful rotation leaves the previous invalid_grant on /internal/health
  // until the next Ensure. Fresh TTL must not keep painting 无效凭证.
  if (state === 'fresh' && CREDENTIAL_REFRESH_FAIL.test(String(lastError || ''))) {
    lastError = null
    lastErrorClass = null
  }
  return {
    has_access: hasAccess,
    has_refresh: hasRefresh,
    needs_refresh: needsRefresh,
    credential_state: state,
    expires_at: expMs || null,
    ttl_seconds: ttlSeconds,
    generation: cred.generation || fileIdentity?.generation || null,
    last_error_class: lastErrorClass,
    last_error: lastError,
    source: liveHealth && healthMs >= fileMs ? 'worker-health' : fileIdentity ? 'slot-credentials' : null,
    observed_at: now,
  }
}

function shouldMirror(vm, live) {
  const vmMs = expiresAtToMs(vm?.expires_at || vm?.claude?.expires_at)
  const liveMs = expiresAtToMs(live?.expires_at)
  return !!(liveMs && liveMs > (vmMs || 0) + MIRROR_NEWER_MS && (live.has_access || live.has_refresh))
}

function collectionKey(projectRoot, list) {
  return JSON.stringify([
    projectRoot,
    list
      .map((vm) => {
        let signature = null
        try {
          const s = fs.statSync(vmJsonPath(projectRoot, vm.id))
          signature = [s.ino, s.mtimeMs, s.size]
        } catch {}
        return [vm.id, vm.status, vm.node_id, vm.owner_user_id, vm.account_uuid, vm.runtime, signature]
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ])
}

function fileCredentialMap(projectRoot, list) {
  const map = new Map()
  for (const vm of list) {
    const exec = slotExec(projectRoot, vm)
    if (!exec) continue
    const live = publicLiveCredential(null, readSlotCredentialIdentity(exec.homeDir))
    if (live.has_access || live.has_refresh || live.expires_at) map.set(vm.id, live)
  }
  return map
}

export async function collectLivePanelCredentials(
  projectRoot,
  vms = [],
  { concurrency = 10, timeoutMs = 1200, cacheMs = LIVE_CREDENTIAL_CACHE_MS, background = false } = {},
) {
  const now = Date.now()
  const list = Array.isArray(vms) ? vms.filter((vm) => vm?.id) : []
  const key = collectionKey(projectRoot, list)
  let entry = cacheMs > 0 ? cache.get(key) : null
  if (entry?.map && now - entry.at < cacheMs) return entry.map
  if (entry?.pending) return background ? entry.map || fileCredentialMap(projectRoot, list) : entry.pending
  entry ||= { at: 0, map: null, pending: null }
  if (cacheMs > 0) {
    cache.set(key, entry)
    if (cache.size > 32) cache.delete(cache.keys().next().value)
  }
  const startedGeneration = generation
  const current = () => generation === startedGeneration && (cacheMs <= 0 || cache.get(key) === entry)
  const map = new Map()
  const pending = mapPool(list, concurrency, async (vm) => {
    const exec = slotExec(projectRoot, vm)
    if (!exec) return
    const file = readSlotCredentialIdentity(exec.homeDir)
    let health = null
    if (vm.status !== 'stopped') {
      try {
        health = await rustKernelHealth(exec, { timeoutMs })
      } catch (error) {
        health = { ok: false, code: 'worker_unavailable', error: String(error.message || error) }
      }
    }
    const live = publicLiveCredential(health, file)
    if (!live.has_access && !live.has_refresh && !live.expires_at) return
    map.set(vm.id, live)
    if (current() && shouldMirror(vm, live) && exec.homeDir) {
      try {
        mirrorWorkerCredentialsToVm(vmJsonPath(projectRoot, vm.id), exec.homeDir)
      } catch {}
    }
  }).then(() => {
    if (current()) {
      entry.at = Date.now()
      entry.map = map
    }
    return map
  })
  entry.pending = pending
  // A failed background refresh must not become an unhandled rejection or a
  // permanently poisoned cache. Detail/diagnostic callers still await freshness.
  void pending.then(
    () => {
      entry.pending = null
    },
    () => {
      entry.pending = null
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  return background ? entry.map || fileCredentialMap(projectRoot, list) : pending
}
