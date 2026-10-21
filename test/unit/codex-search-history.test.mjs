import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchHistoryFallback } from '../../src/lib/protocol/codex-search-history.mjs'

function fixture() {
  const body = {
    model: 'gpt-6.1-sol',
    input: [
      { type: 'message', role: 'user', content: 'Original request' },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'docs' } },
      { type: 'reasoning', encrypted_content: 'opaque-history' },
      { type: 'compaction_trigger' },
    ],
    tools: [],
    tool_choice: 'auto',
    stream: true,
    prompt_cache_key: 'original-session',
  }
  return {
    args: {
      body,
      envelope: { body, headers: { 'session-id': 'original-session' }, session: { session_id: 'original-session' } },
    },
    result: {
      ok: false,
      status: 400,
      body: { error: { code: 'upstream_status', message: 'response protection is unavailable' } },
    },
  }
}

test('search recovery preserves all history, credentials context and request semantics', () => {
  const { args, result } = fixture()
  const before = structuredClone(args)
  const recovered = searchHistoryFallback(args, result)
  assert.deepEqual(args, before)
  assert.strictEqual(recovered.args.body.input, args.body.input)
  assert.strictEqual(recovered.args.envelope.body, recovered.args.body)
  assert.strictEqual(recovered.args.envelope.headers, args.envelope.headers)
  assert.strictEqual(recovered.args.envelope.session, args.envelope.session)
  assert.deepEqual(recovered.args.body, { ...args.body, tools: [{ type: 'web_search' }], tool_choice: 'none' })
  assert.deepEqual(recovered.info, { search_items: 1 })
})

test('search recovery only handles the observed silent protection failure', () => {
  const { args, result } = fixture()
  for (const overrides of [
    { ok: true },
    { committed: true },
    { transportError: true },
    { status: 401 },
    { status: 429 },
    { body: { error: { message: 'Our servers are currently overloaded. Please try again later.' } } },
  ])
    assert.equal(searchHistoryFallback(args, { ...result, ...overrides }), null)
  assert.equal(searchHistoryFallback({ ...args, signal: { aborted: true } }, result), null)
})

test('search recovery cannot disable declared tools, forced choices, or reference-based continuations', () => {
  const { args, result } = fixture()
  for (const overrides of [
    { tools: [{ type: 'function', name: 'read_file' }] },
    { tools: [{ type: 'web_search' }] },
    { tools: {} },
    { tool_choice: 'required' },
    { tool_choice: { type: 'function', name: 'read_file' } },
    { previous_response_id: 'resp_1' },
    { input: [{ type: 'compaction_trigger' }] },
    { input: 'text' },
  ])
    assert.equal(searchHistoryFallback({ ...args, body: { ...args.body, ...overrides } }, result), null)
  assert.equal(
    searchHistoryFallback({ ...args, envelope: { session: { previous_response_id: 'resp_1' } } }, result),
    null,
  )
  assert.equal(searchHistoryFallback(), null)
})
