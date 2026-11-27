import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCchBytes } from '../../deploy/cli-cch-bytes.mjs'

test('CCH projects nested models and excludes only the first legacy optional fields', () => {
  const input =
    '{"model":"中文😀","nested":{"model":"a\\\"b","max_tokens":128},"max_tokens":256,"fallbacks":[["x]"],{"model":"c"}],"fallback_credit_token":"q\\\"r","later":{"fallbacks":[1],"fallback_credit_token":"keep"}}'
  assert.equal(
    projectCchBytes(input).toString('utf8'),
    '{"model":"","nested":{"model":""},"max_tokens":256,"later":{"fallbacks":[1],"fallback_credit_token":"keep"}}',
  )
})

test('CCH preserves Unicode content and upstream numeric projection edge cases', () => {
  for (const [input, expected] of [
    ['{"model":"中","max_tokens":5,"content":"中文😀"}', '{"model":"","content":"中文😀"}'],
    ['{"max_tokens":1.5,"keep":true}', '{.5,"keep":true}'],
    ['{"max_tokens":-1,"model":123}', '{"max_tokens":-1,"model":123}'],
    ['{"fallbacks":[],"fallback_credit_token":"x","max_tokens":0}', '{}'],
    ['{"content":"\\\"model\\\":\\\"keep\\\""}', '{"content":"\\\"model\\\":\\\"keep\\\""}'],
  ])
    assert.equal(projectCchBytes(input).toString('utf8'), expected)
})
