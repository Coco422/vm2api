import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestLogStore, normalizeLoggingConfig } from '../../src/lib/admin/request-log.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-retention-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash)
      VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id)
      VALUES ('k1', 'alice-key', 'sk-local-a', 'u1'), ('k2', 'bob-key', 'sk-local-b', 'u2');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}');
  `)
  const repo = new UsageLogsRepo(db)
  const now = Date.now()
  const ago = (days) => new Date(now - days * 86400_000).toISOString()
  function insert(id, days, extra = {}) {
    repo.insertSummary({
      id,
      request_id: id,
      created_at: ago(days),
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      log_mode: 'normal',
      pricing_model: 'unpriced',
      ...extra,
    })
  }
  return { dir, db, repo, now, ago, insert }
}

test('new stores and normalized config default to 30 days of ordinary logs', (t) => {
  const { db, dir } = fixture(t)
  assert.equal(new RequestLogStore({ db, dataDir: dir }).snapshot().retain_days, 30)
  assert.equal(normalizeLoggingConfig({}).retain_days, 30)
  assert.equal(normalizeLoggingConfig({}).debug_retain_days, 3)
})

test('cleanup and restart preserve separate old/new account bills on a reused VM', (t) => {
  const { db, repo, now, ago, insert } = fixture(t)
  insert('old-account', 45, {
    vm_id: 'vm-a',
    account_id: 'account-old',
    final_account_id: 'account-old',
    user_id: 'u1',
    vm_owner_user_id: 'u1',
    api_key_id: 'k1',
    model: 'claude-sonnet-5',
    pricing_model: 'claude-sonnet-5',
    input_tokens: 1000,
    output_tokens: 200,
    total_cost: 193.25,
    actual_cost: 386.5,
  })
  insert('new-account', 1, {
    vm_id: 'vm-a',
    account_id: 'account-new',
    final_account_id: 'account-new',
    user_id: 'u1',
    vm_owner_user_id: 'u1',
    api_key_id: 'k1',
    model: 'claude-sonnet-5',
    pricing_model: 'claude-sonnet-5',
    input_tokens: 100,
    output_tokens: 20,
    total_cost: 1.5,
    actual_cost: 3,
  })
  insert('other-owner', 40, {
    vm_id: 'vm-a',
    account_id: 'other-account',
    user_id: 'u2',
    vm_owner_user_id: 'u2',
    api_key_id: 'k2',
    total_cost: 50,
    actual_cost: 50,
  })
  repo.insertDebug('old-account', ago(45), { inbound_body: { messages: ['body'] } })
  const accountsBefore = repo.costByAccount()
  const tenantBefore = repo.ownerBilling({ ownerUserId: 'u1', groupBy: 'key' })
  const billBefore = repo.billingStats({ now })
  assert.deepEqual(repo.cleanup({ retainDays: 30, debugRetainDays: 3 }), {
    usage_logs: 0,
    request_log_debug: 1,
    debug_by_age: 1,
    debug_by_size: 0,
  })
  assert.equal(repo.getDebug('old-account'), null)
  assert.equal(repo.getByRequestId('old-account').total_cost, 193.25)
  const restarted = new UsageLogsRepo(db)
  assert.deepEqual(restarted.costByAccount(), accountsBefore)
  assert.deepEqual(restarted.ownerBilling({ ownerUserId: 'u1', groupBy: 'key' }), tenantBefore)
  assert.equal(tenantBefore.totals.official_cost_usd, 194.75)
  assert.equal(tenantBefore.totals.cost_usd, 389.5)
  assert.deepEqual(restarted.billingStats({ now }).total, billBefore.total)
  assert.equal(restarted.costByModel({ vmId: 'vm-a', accountId: 'account-old' })[0].total_cost, 193.25)
  assert.equal(restarted.costByModel({ vmId: 'vm-a', accountId: 'account-new' })[0].total_cost, 1.5)
  assert.deepEqual(
    restarted.costByAccount({ since: ago(30) }).map((row) => row.account_id),
    ['account-new'],
  )
  assert.equal(restarted.cleanup({ retainDays: 30 }).usage_logs, 0)
})

test('30-day cleanup removes only expired unowned access logs', (t) => {
  const { repo, insert } = fixture(t)
  insert('expired-ingress', 31)
  insert('recent-ingress', 29)
  insert('old-vm-call', 60, { vm_id: 'vm-a' })
  insert('old-account-call', 60, { account_id: 'account-old' })
  insert('old-final-account', 60, { final_account_id: 'account-old' })
  insert('old-key-call', 60, { api_key_id: 'k1' })
  assert.equal(repo.cleanup().usage_logs, 1)
  assert.equal(repo.getByRequestId('expired-ingress'), null)
  for (const id of ['recent-ingress', 'old-vm-call', 'old-account-call', 'old-final-account', 'old-key-call'])
    assert.ok(repo.getByRequestId(id), id)
})

test('orphaned token, search, image and cost evidence survives age and debug size cleanup', (t) => {
  const { repo, ago, insert } = fixture(t)
  const evidence = [
    { input_tokens: 1 },
    { output_tokens: 1 },
    { cache_read_tokens: 1 },
    { cache_creation_tokens: 1 },
    { cache_creation_5m_tokens: 1 },
    { cache_creation_1h_tokens: 1 },
    { image_input_tokens: 1 },
    { image_output_tokens: 1 },
    { web_search_requests: 1 },
    { input_cost: 0.01 },
    { output_cost: 0.01 },
    { cache_read_cost: 0.01 },
    { cache_creation_cost: 0.01 },
    { web_search_cost: 0.01 },
    { image_cost: 0.01 },
    { total_cost: 0.01 },
    { actual_cost: 0.01 },
    { image_usage: '{"total_tokens":1}' },
  ]
  evidence.forEach((row, i) => {
    insert(`evidence-${i}`, 60, row)
    repo.insertDebug(`evidence-${i}`, ago(1), { body: 'x'.repeat(500) })
  })
  const result = repo.cleanup({ retainDays: 30, maxBytes: 1 })
  assert.equal(result.usage_logs, 0)
  assert.equal(result.debug_by_size, evidence.length)
  evidence.forEach((row, i) => {
    const kept = repo.getByRequestId(`evidence-${i}`)
    for (const [column, value] of Object.entries(row)) assert.equal(kept[column], value)
    assert.equal(repo.getDebug(`evidence-${i}`), null)
  })
})
