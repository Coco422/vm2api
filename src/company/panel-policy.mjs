/** Panel sessions also accept cookies: coupon POSTs must not be triggered by another site. */
export function companyPanelMutationError(req) {
  if (String(req.method).toUpperCase() !== 'POST') return null
  if (req.headers.origin) {
    let sameOrigin = false
    try {
      sameOrigin = new URL(req.headers.origin).host === req.headers.host
    } catch {}
    if (!sameOrigin) return { status: 403, code: 'origin_denied', message: '请从员工控制台发起操作' }
  }
  if (
    !String(req.headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return { status: 415, code: 'json_required', message: '请发送 JSON 请求' }
  }
  return null
}
