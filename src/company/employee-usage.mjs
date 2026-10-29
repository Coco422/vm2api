/** Employee history must match BOTH the presented key and its recorded caller.
 * Do not reuse panel ownerPred: that ORs current key/VM ownership into history.
 */
import { shanghaiDayStartIso } from '../lib/admin/pricing.mjs'
import { SUCCESS_PRED } from '../lib/db/repos/usage-log-preds.mjs'

const SUMS = `COUNT(*) AS requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
  COALESCE(SUM(input_cost), 0) AS input_cost,
  COALESCE(SUM(output_cost), 0) AS output_cost,
  COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
  COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
  COALESCE(SUM(web_search_cost), 0) AS web_search_cost,
  COALESCE(SUM(total_cost), 0) AS official_cost_usd,
  COALESCE(SUM(COALESCE(actual_cost, total_cost)), 0) AS budget_cost_usd,
  SUM(CASE WHEN total_cost IS NULL THEN 1 ELSE 0 END) AS unpriced_requests`

function numbers(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : Number(v) || 0]))
}

export function employeeUsage(db, { keyId, userId, days = 30 }) {
  if (!keyId || !userId || ![7, 30, 90].includes(days)) throw new Error('Invalid employee usage scope')
  const since = new Date(Date.parse(shanghaiDayStartIso()) - (days - 1) * 86400_000).toISOString()
  const until = new Date().toISOString()
  const where = 'WHERE api_key_id = ? AND user_id = ? AND created_at >= ? AND created_at <= ?'
  const params = [keyId, userId, since, until]
  const totals = numbers(db.prepare(`SELECT ${SUMS} FROM usage_logs ${where}`).get(...params))
  const history = db
    .prepare(`SELECT strftime('%Y-%m-%d', created_at, '+8 hours') AS day, ${SUMS}
    FROM usage_logs ${where} GROUP BY day ORDER BY day`)
    .all(...params)
    .map(numbers)
  const models = db
    .prepare(`SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), '—') AS name, ${SUMS}
    FROM usage_logs ${where} GROUP BY name ORDER BY requests DESC LIMIT 20`)
    .all(...params)
    .map(numbers)
  return { days, since, until, timezone: 'Asia/Shanghai', currency: 'USD', totals, history, models }
}

export function employeeDayRequests(db, { keyId, userId, day, page = 1, pageSize = 20, snapshot = null }) {
  const invalid = () => Object.assign(new Error('Invalid request day or pagination'), { code: 'invalid_request_query' })
  if (!keyId || !userId || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw invalid()
  const date = Date.parse(`${day}T00:00:00.000Z`)
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== day ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw invalid()
  const now = Date.now()
  const snapshotMs = snapshot == null ? now : Date.parse(snapshot)
  if (
    !Number.isFinite(snapshotMs) ||
    snapshotMs > now ||
    (snapshot != null && new Date(snapshotMs).toISOString() !== snapshot)
  )
    throw invalid()
  const since = new Date(date - 8 * 3600_000).toISOString()
  const until = new Date(date - 8 * 3600_000 + 86400_000).toISOString()
  const sampledAt = new Date(snapshotMs).toISOString()
  const where = 'WHERE api_key_id = ? AND user_id = ? AND created_at >= ? AND created_at < ? AND created_at <= ?'
  const params = [keyId, userId, since, until, sampledAt]
  const totals = numbers(db.prepare(`SELECT ${SUMS} FROM usage_logs ${where}`).get(...params))
  // Explicit column projection: never expose captured payloads, credential/header fields or raw upstream errors.
  const items = db
    .prepare(`SELECT id, request_id, created_at,
    COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '—') AS model,
    requested_model, protocol, stream, status, duration_ms, first_token_ms,
    CASE WHEN status IS NULL THEN 'unknown' WHEN ${SUCCESS_PRED} THEN 'success' ELSE 'error' END AS result,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    cache_creation_5m_tokens, cache_creation_1h_tokens,
    input_cost, output_cost, cache_read_cost, cache_creation_cost, web_search_cost,
    total_cost AS official_cost_usd, COALESCE(actual_cost, total_cost) AS budget_cost_usd
    FROM usage_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map((row) => ({ ...row, stream: row.stream === 1 }))
  return {
    day,
    timezone: 'Asia/Shanghai',
    currency: 'USD',
    snapshot: sampledAt,
    page,
    page_size: pageSize,
    total: totals.requests,
    total_pages: Math.ceil(totals.requests / pageSize),
    totals,
    items,
  }
}
