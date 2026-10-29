import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { redeemEmployeeOpenai, reviewEmployeeOpenaiReset } from '../../src/company/employee-reset.mjs'
import { redeemCompanyOpenaiReset, reviewCompanyOpenaiReset } from '../../src/company/quota-reset-receipt.mjs'

test('OpenAI employee coupon receipt survives handler recreation and blocks ambiguous retries', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  let calls = 0
  const run = async () => {
    calls++
    return { ok: true, data: { reset_credits: { available_count: 1 } } }
  }
  const args = { db, vmId: 'vm-a', operationId: 'test-operation-1', run, now: 1000 }
  const first = await redeemEmployeeOpenai(args)
  assert.equal(first.data.outcome, 'reset')
  assert.deepEqual(await redeemEmployeeOpenai(args), first)
  assert.equal(calls, 1)
  assert.equal((await redeemEmployeeOpenai({ ...args, operationId: 'test-operation-2' })).status, 409)
  const unknown = await redeemEmployeeOpenai({
    ...args,
    operationId: 'test-operation-2',
    now: 100000,
    run: async () => {
      calls++
      throw new Error('timeout')
    },
  })
  assert.equal(unknown.data.outcome, 'unknown')
  assert.equal(
    (await redeemEmployeeOpenai({ ...args, operationId: 'test-operation-3', now: 200000 })).data.outcome,
    'unknown',
  )
  assert.equal(calls, 2)
  assert.deepEqual(reviewEmployeeOpenaiReset({ db, vmId: 'vm-a' }), { exists: true, pending: true, at: 100000 })
  assert.throws(() => reviewEmployeeOpenaiReset({ db, vmId: 'vm-a', confirm: true, expectedAt: 999 }))
  assert.equal(
    reviewEmployeeOpenaiReset({ db, vmId: 'vm-a', confirm: true, expectedAt: 100000, now: 200000 }).pending,
    false,
  )
  assert.equal(
    (await redeemEmployeeOpenai({ ...args, operationId: 'test-operation-2', now: 300000 })).data.outcome,
    'already_used',
  )
  assert.equal(calls, 2)
  assert.doesNotMatch(
    JSON.stringify(db.prepare('SELECT value FROM settings WHERE key LIKE ?').all('company.%')),
    /test-operation-/,
  )
})

test('production receipt exports preserve the same durable implementation', () => {
  assert.equal(redeemCompanyOpenaiReset, redeemEmployeeOpenai)
  assert.equal(reviewCompanyOpenaiReset, reviewEmployeeOpenaiReset)
})
