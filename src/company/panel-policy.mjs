/** Panel sessions accept cookies: self-service writes must stay same-origin and JSON. */
export function companyPanelMutationError(req) {
  const method = String(req.method).toUpperCase()
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) return null
  if (req.headers.origin) {
    let sameOrigin = false
    try {
      sameOrigin = new URL(req.headers.origin).host === req.headers.host
    } catch {}
    if (!sameOrigin) return { status: 403, code: 'origin_denied', message: '请从控制台发起操作' }
  }
  if (
    method !== 'DELETE' &&
    !String(req.headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return { status: 415, code: 'json_required', message: '请发送 JSON 请求' }
  }
  return null
}
