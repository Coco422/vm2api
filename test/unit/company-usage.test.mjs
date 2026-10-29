import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { employeeUsage, employeeDayRequests } from '../../src/company/employee-usage.mjs'

test('employee billing isolates historical owner and key; keeps cache categories and missing prices', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-billing-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const logs = new UsageLogsRepo(db)
  const insert = (id, fields = {}) =>
    logs.insertSummary({
      id,
      request_id: id,
      created_at: new Date().toISOString(),
      status: 200,
      user_id: 'alice',
      api_key_id: 'key-a',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 20,
      cache_creation_tokens: 30,
      input_cost: 1,
      output_cost: 2,
      cache_read_cost: 3,
      cache_creation_cost: 4,
      web_search_cost: 5,
      total_cost: 15,
      actual_cost: 30,
      ...fields,
    })
  insert('mine')
  insert('previous-owner', { user_id: 'bob', total_cost: 999 })
  insert('other-key', { api_key_id: 'key-b', total_cost: 999 })
  insert('legacy-unowned', { user_id: null, total_cost: 999 })
  insert('old', { created_at: '2020-01-01T00:00:00Z', total_cost: 999 })
  insert('future', { created_at: '2099-01-01T00:00:00Z', total_cost: 999 })
  insert('unknown', { total_cost: null, actual_cost: null, pricing_model: 'unpriced' })
  const result = employeeUsage(db, { keyId: 'key-a', userId: 'alice', days: 30 })
  assert.equal(result.totals.requests, 2)
  assert.equal(result.totals.official_cost_usd, 15)
  assert.equal(result.totals.budget_cost_usd, 30)
  assert.equal(result.totals.cache_read_tokens, 40)
  assert.equal(result.totals.cache_creation_tokens, 60)
  assert.equal(result.totals.unpriced_requests, 1)
  assert.equal(result.history.length, 1)
  assert.equal(result.models[0].requests, 2)
  assert.equal(employeeUsage(db, { keyId: "key-a' OR 1=1 --", userId: 'alice' }).totals.requests, 0)
  assert.throws(() => employeeUsage(db, { keyId: 'key-a', userId: '' }))
})

test('single-day requests use Shanghai boundaries, strict historical ownership and stable pagination order', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const logs = new UsageLogsRepo(db)
  const insert = (id, fields = {}) =>
    logs.insertSummary({
      id,
      request_id: id,
      created_at: '2024-02-29T03:00:00.000Z',
      user_id: 'alice',
      api_key_id: 'key-a',
      status: 200,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 30,
      cache_creation_tokens: 40,
      total_cost: 1,
      actual_cost: 2,
      api_key_presented: 'must-not-leak',
      error_message: 'private-upstream-message',
      ...fields,
    })
  insert('start', { created_at: '2024-02-28T16:00:00.000Z' })
  insert('before', { created_at: '2024-02-28T15:59:59.999Z' })
  insert('end', { created_at: '2024-02-29T16:00:00.000Z' })
  insert('previous-owner', { user_id: 'bob' })
  insert('other-key', { api_key_id: 'key-b' })
  insert('no-owner', { user_id: null })
  for (let i = 0; i < 24; i++)
    insert(`mine-${String(i).padStart(2, '0')}`, i === 0 ? { status: 500, total_cost: null, actual_cost: null } : {})
  const args = { keyId: 'key-a', userId: 'alice', day: '2024-02-29' }
  const first = employeeDayRequests(db, args)
  const second = employeeDayRequests(db, { ...args, page: 2, snapshot: first.snapshot })
  assert.equal(first.total, 25)
  assert.equal(first.items.length, 20)
  assert.equal(second.items.length, 5)
  assert.equal(first.total_pages, 2)
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 25)
  assert.equal(first.items[0].id, 'mine-23')
  assert.equal(second.items.at(-1).id, 'start')
  const failed = second.items.find((row) => row.id === 'mine-00')
  assert.equal(failed.result, 'error')
  assert.equal(failed.official_cost_usd, null)
  assert.equal(first.totals.unpriced_requests, 1)
  assert.equal(first.totals.official_cost_usd, 24)
  assert.equal(first.totals.cache_read_tokens, 750)
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak|private-upstream-message|api_key_presented|error_message/)
  assert.equal(employeeDayRequests(db, { ...args, page: 3 }).items.length, 0)
  assert.equal(employeeDayRequests(db, { ...args, day: '2024-03-02' }).total, 0)
  assert.equal(employeeDayRequests(db, { ...args, keyId: "key-a' OR 1=1 --" }).total, 0)
})

test('single-day request parameters reject impossible dates, invalid page sizes and forged future snapshots', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const args = { keyId: 'key-a', userId: 'alice', day: '2024-02-29' }
  for (const patch of [
    { day: '2024-02-30' },
    { day: '2023-02-29' },
    { day: '2024-2-29' },
    { day: "' OR 1=1 --" },
    { page: 0 },
    { page: 1.5 },
    { pageSize: 101 },
    { pageSize: 0 },
    { snapshot: '2099-01-01T00:00:00.000Z' },
    { snapshot: 'bad' },
  ]) {
    assert.throws(() => employeeDayRequests(db, { ...args, ...patch }), { code: 'invalid_request_query' })
  }
})
