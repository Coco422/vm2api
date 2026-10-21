// A tool-free checkpoint can still replay prior web_search_call items. The
// upstream needs the search declaration to render that history, even though
// this request must not perform any new searches. Recover only the observed
// pre-output protection error; keep every history item and the session intact.
export function searchHistoryFallback(args = {}, result) {
  const body = args.body
  const error = result?.body?.error || result?.body?.response?.error
  if (result?.ok || result?.committed || result?.transportError || args.signal?.aborted) return null
  if (![400, 500, 502].includes(Number(result?.status))) return null
  if (error?.message !== 'response protection is unavailable') return null
  if (!Array.isArray(body?.input) || body.previous_response_id || args.envelope?.session?.previous_response_id)
    return null
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 0)) return null
  if (body.tool_choice != null && !['auto', 'none'].includes(body.tool_choice)) return null
  const searchItems = body.input.filter((item) => item?.type === 'web_search_call').length
  if (!searchItems) return null
  const nextBody = { ...body, tools: [{ type: 'web_search' }], tool_choice: 'none' }
  return {
    args: { ...args, body: nextBody, envelope: { ...args.envelope, body: nextBody } },
    info: { search_items: searchItems },
  }
}
