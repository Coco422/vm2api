import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { armWriteBehind, flushWrites, pendingWrites, writeBehindArmed } from '../../src/lib/db/write-behind.mjs'

test('finish returns before the usage row is written, and flush commits it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  armWriteBehind(db)
  try {
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = store.finish(ctx, { status: 200, model: 'claude-haiku-4-5', input_tokens: 3, output_tokens: 1 })
    assert.equal(pendingWrites() > 0, true)
    assert.equal(store.repo.getByRequestId(summary.request_id), null)
    flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.equal(store.repo.getByRequestId(summary.request_id)?.status, 200)
    assert.equal(writeBehindArmed(), true)
  } finally {
    armWriteBehind(null)
    flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const phase of ['BEGIN IMMEDIATE', 'statement', 'COMMIT']) {
  test(`${phase} failure keeps an atomic batch and replays each ledger row once`, async () => {
    const { enqueueWrite } = await import('../../src/lib/db/write-behind.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-fault-'))
    const db = createDatabase({ dataDir: dir })
    db.exec('CREATE TABLE fault_ledger (id TEXT PRIMARY KEY, amount INTEGER)')
    let fail = true
    armWriteBehind({
      exec(sql) {
        if (fail && sql === phase) throw new Error(`injected ${phase}`)
        return db.exec(sql)
      },
    })
    const insert = db.prepare('INSERT INTO fault_ledger VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    try {
      enqueueWrite(() => insert.run('a', 3))
      enqueueWrite(() => {
        if (phase === 'statement' && fail) throw new Error('injected statement')
        insert.run('b', 7)
      })
      assert.throws(flushWrites, { code: 'WRITE_BEHIND_PENDING' })
      assert.equal(pendingWrites(), 2)
      assert.equal(db.prepare('SELECT count(*) AS n FROM fault_ledger').get().n, 0)
      assert.throws(() => armWriteBehind(null), { code: 'WRITE_BEHIND_PENDING' })
      fail = false
      flushWrites()
      flushWrites()
      assert.equal(pendingWrites(), 0)
      assert.deepEqual(
        { ...db.prepare('SELECT count(*) AS n, sum(amount) AS total FROM fault_ledger').get() },
        { n: 2, total: 10 },
      )
    } finally {
      fail = false
      flushWrites()
      armWriteBehind(null)
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('a failed summary insert is retained; retry preserves completion-time ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-summary-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  armWriteBehind(db)
  const insert = store.repo.insertSummaryIfAbsent.bind(store.repo)
  let fail = true
  let owner = 'original-owner'
  store.repo.vmOwnerOf = () => owner
  store.repo.insertSummaryIfAbsent = (summary) => {
    if (fail) throw new Error('injected ledger failure')
    return insert(summary)
  }
  try {
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const row = store.finish(ctx, { status: 200, vm_id: 'vm-owned', input_tokens: 5, model: 'claude-haiku-4-5' })
    owner = 'new-owner'
    assert.throws(flushWrites, { code: 'WRITE_BEHIND_PENDING' })
    assert.equal(pendingWrites(), 1)
    fail = false
    flushWrites()
    assert.equal(store.repo.getByRequestId(row.request_id).vm_owner_user_id, 'original-owner')
  } finally {
    fail = false
    flushWrites()
    armWriteBehind(null)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('graceful shutdown waits for queued ledger recovery before reporting completion', async () => {
  const { enqueueWrite } = await import('../../src/lib/db/write-behind.mjs')
  const { createGracefulShutdown } = await import('../../src/lib/http/graceful-shutdown.mjs')
  let fail = true
  let committed = false
  const exits = []
  armWriteBehind({
    exec(sql) {
      if (fail && sql === 'COMMIT') throw new Error('injected commit')
    },
  })
  enqueueWrite(() => {
    committed = true
  })
  const shutdown = createGracefulShutdown({
    logger: { log() {}, warn() {} },
    afterDrain: () => {
      flushWrites()
      armWriteBehind(null)
    },
    exit: (code) => exits.push(code),
  })
  const done = shutdown.shutdown()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(exits, [])
  assert.equal(pendingWrites(), 1)
  fail = false
  await done
  assert.equal(committed, true)
  assert.equal(pendingWrites(), 0)
  assert.deepEqual(exits, [0])
})
