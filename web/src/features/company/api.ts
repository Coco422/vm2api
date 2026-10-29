export type EmployeeVm = {
  id: string
  name: string
  platform: 'anthropic' | 'openai'
  tier: string
  schedulable: boolean
  credential_ready: boolean
  reset_supported: boolean
  quota: Record<
    'five_hour' | 'seven_day',
    { used_percent: number | null; resets_at: string | null }
  >
}

export type EmployeeMe = {
  employee: { name: string }
  key: {
    name: string
    status: string
    expires_at: string | null
    inference_allowed: boolean
    inference_error: string | null
    quota_usd: number
    quota_usd_used: number
    quota_requests: number
    quota_requests_used: number
    windows: {
      window: string
      limit_usd: number
      used_usd: number
      started_at: string | null
    }[]
  }
  vms: EmployeeVm[]
}

export type UsageTotals = {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  input_cost: number
  output_cost: number
  cache_read_cost: number
  cache_creation_cost: number
  web_search_cost: number
  official_cost_usd: number
  budget_cost_usd: number
  unpriced_requests: number
}

export type EmployeeUsage = {
  days: number
  since: string
  until: string
  totals: UsageTotals
  history: (UsageTotals & { day: string })[]
  models: (UsageTotals & { name: string })[]
}

export type ResetResult = {
  outcome: string | null
  warning: string | null
  reset_credits: {
    available_count: number
    credits: {
      label: string
      resets_left: number
      expires_at: string | null
      redeemable: boolean
    }[]
  } | null
}

export type EmployeeDayRequests = {
  day: string
  snapshot: string
  page: number
  page_size: number
  total: number
  total_pages: number
  totals: UsageTotals
  items: {
    id: string
    request_id: string
    created_at: string
    model: string
    requested_model: string | null
    protocol: string | null
    stream: boolean
    status: number | null
    result: 'success' | 'error' | 'unknown'
    duration_ms: number | null
    first_token_ms: number | null
    input_tokens: number | null
    output_tokens: number | null
    cache_read_tokens: number | null
    cache_creation_tokens: number | null
    cache_creation_5m_tokens: number | null
    cache_creation_1h_tokens: number | null
    input_cost: number | null
    output_cost: number | null
    cache_read_cost: number | null
    cache_creation_cost: number | null
    web_search_cost: number | null
    official_cost_usd: number | null
    budget_cost_usd: number | null
  }[]
}

export function dayRequestsPath(day: string, page: number, snapshot?: string) {
  const query = new URLSearchParams({
    day,
    page: String(page),
    page_size: '20',
  })
  if (snapshot) query.set('snapshot', snapshot)
  return `/api/company/requests?${query}`
}

export class EmployeeApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

/** Deliberately separate from the panel client: no panel token, base URL or persistence. */
export async function employeeRequest<T>(
  key: string,
  route: string,
  options: { signal?: AbortSignal; operationId?: string } = {}
): Promise<T> {
  if (!route.startsWith('/api/company/'))
    throw new Error('Invalid employee API route')
  const post = /\/(refresh|reset-query|reset-redeem)$/.test(route)
  const response = await fetch(route, {
    method: post ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(post ? { 'Content-Type': 'application/json' } : {}),
      ...(options.operationId
        ? { 'Idempotency-Key': options.operationId }
        : {}),
    },
    body: post ? '{}' : undefined,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: options.signal || AbortSignal.timeout(90_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true)
    throw new EmployeeApiError(
      response.status,
      payload?.error?.code || 'request_failed',
      payload?.error?.message || '服务暂时不可用，请稍后重试'
    )
  return payload.data as T
}

export function budgetWindowUsed(
  window: EmployeeMe['key']['windows'][number],
  now = Date.now()
) {
  const duration = { '5h': 5 * 3600_000, '1d': 86400_000, '7d': 7 * 86400_000 }[
    window.window
  ]
  const started = Date.parse(window.started_at || '')
  return duration && Number.isFinite(started) && now - started < duration
    ? window.used_usd
    : 0
}
