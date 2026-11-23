import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { readAll, usageRead } from '../../src/lib/db/sqlite-pool.mjs'

test('usage reads run on read-only workers and leave the event loop free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sqlite-pool-'))
  openDatabase({ dataDir: dir, pooled: true })
  try {
    await readAll('SELECT 1 AS n')
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 5)
    const started = Date.now()
    const rows = await readAll(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT max(x) AS n FROM c',
    )
    const elapsed = Date.now() - started
    clearInterval(timer)
    assert.equal(Number(rows[0].n), 4000000)
    assert.ok(elapsed >= 20, `scan finished too fast to observe the loop: ${elapsed}ms`)
    assert.ok(ticks > 0, `main thread did not tick during a ${elapsed}ms scan`)

    await assert.rejects(readAll('CREATE TABLE forbidden_write (id INTEGER)'), /readonly/)

    const local = new UsageLogsRepo(getDb()).totals()
    const remote = await usageRead({ kind: 'repo', method: 'totals' })
    assert.equal(Number(remote.requests), Number(local.requests))

    const repo = new UsageLogsRepo(getDb())
    const stamp = Date.now()
    for (const [id, vm, account, hours, cost, status] of [
      ['old', 'vm-a', 'old-account', 24 * 40, 9.25, 200],
      ['current', 'vm-a', 'new-account', 1, 1.5, 200],
      ['other', 'vm-b', 'other-account', 2, 7.25, 200],
      ['error', 'vm-b', 'other-account', 1, 0, 503],
    ]) {
      repo.insertSummary({
        id,
        request_id: id,
        vm_id: vm,
        account_id: account,
        final_account_id: account,
        created_at: new Date(stamp - hours * 3600_000).toISOString(),
        path: '/v1/messages',
        method: 'POST',
        status,
        log_mode: 'normal',
        input_tokens: 10,
        output_tokens: 20,
        total_cost: cost,
      })
    }
    const options = {
      now: stamp,
      readOnly: true,
      accountWindows: [
        { vm_id: 'vm-a', account_id: 'new-account', reset_5h: (stamp + 3600_000) / 1000 },
        { vm_id: 'vm-b', account_id: 'other-account', reset_7d: (stamp + 86400_000) / 1000 },
      ],
    }
    const rowsBefore = getDb().prepare('SELECT * FROM usage_logs ORDER BY id').all()
    repo.backfillMissingCosts = () => {
      throw new Error('read-only display must never backfill')
    }
    const expected = repo.billingStats(options)
    const billed = await usageRead({ kind: 'repo', method: 'billingStats', args: [options] })
    assert.deepEqual(billed, expected)
    assert.equal(billed.accounts.length, 3)
    assert.equal(billed.total.requests, 4)
    assert.deepEqual(getDb().prepare('SELECT * FROM usage_logs ORDER BY id').all(), rowsBefore)
    assert.equal(repo._billingBackfillAt, 0)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
