/** Company-only receipt for OpenAI: upstream's helper generates a new request id per call.
 * Persist before dispatch; repeated clicks / process restarts must never consume another coupon.
 */
import crypto from 'node:crypto'
import { SettingsRepo } from '../lib/db/repos/settings-repo.mjs'

export async function redeemEmployeeOpenai({ db, vmId, operationId, run, now = Date.now() }) {
  const settings = new SettingsRepo(db)
  const key = `company.openai_reset.${vmId}`
  const hash = crypto.createHash('sha256').update(operationId).digest('hex')
  const prior = settings.get(key)
  if (prior?.operation === hash) return prior.result || { ok: true, data: { outcome: 'unknown' } }
  // Outcome must be confirmed before a DIFFERENT operation can spend another reset.
  if (prior?.pending) return { ok: true, data: { outcome: 'unknown' } }
  if (prior && now - prior.at < 60_000) return { status: 409, ok: false }
  settings.set(key, { operation: hash, at: now, pending: true })
  let result
  try {
    const raw = await run()
    // Even an upstream error can follow an accepted redemption: fail closed until reviewed.
    if (raw.status || raw.ok === false) return { ok: true, data: { outcome: 'unknown' } }
    const data = raw.data || raw
    result = {
      ok: true,
      data: { outcome: 'reset', warning: data.warning || null, reset_credits: data.reset_credits || null },
    }
    settings.set(key, { operation: hash, at: now, pending: false, result })
    return result
  } catch {
    return { ok: true, data: { outcome: 'unknown' } }
  }
}

/** Operator-only maintenance, called by a local CLI after independently reviewing upstream state. */
export function reviewEmployeeOpenaiReset({ db, vmId, expectedAt = null, confirm = false, now = Date.now() }) {
  const settings = new SettingsRepo(db)
  const key = `company.openai_reset.${vmId}`
  const prior = settings.get(key)
  if (!prior) return { exists: false }
  if (confirm) {
    if (!prior.pending || expectedAt !== prior.at) throw new Error('Pending reset changed; read status again')
    settings.set(key, {
      ...prior,
      at: now,
      pending: false,
      reviewed_at: new Date(now).toISOString(),
      result: { ok: true, data: { outcome: 'already_used' } },
    })
  }
  return { exists: true, pending: confirm ? false : prior.pending === true, at: confirm ? now : prior.at }
}
