import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelBillingReader, panelQuotaSnapshot } from '../../src/company/panel-billing-reader.mjs'
import { buildVmDetail, buildVmList, buildUsageAsync, snapshotAccountPool } from '../../src/lib/admin/panel-api.mjs'

test('quota snapshot is request-scoped and VM list does not reread every account for each row', async (t) => {
  let snapshots = 0
  const quota = { config: {}, snapshot: () => ({ accounts: [], sequence: ++snapshots }) }
  const first = panelQuotaSnapshot(quota)
  assert.equal(first.snapshot().sequence, 1)
  assert.equal(first.snapshot().sequence, 1)
  assert.equal(panelQuotaSnapshot(first), first)
  assert.equal(panelQuotaSnapshot(quota).snapshot().sequence, 2)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-perf-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const id of ['vm-a', 'vm-b', 'vm-c']) {
    fs.writeFileSync(path.join(root, 'vms', id + '.json'), JSON.stringify({ id, status: 'stopped' }))
  }
  snapshots = 0
  const listed = await buildVmList({ cfg: { paths: { project: root } }, accountQuota: quota })
  assert.equal(listed.data.items.length, 3)
  assert.equal(snapshots, 1)
  snapshots = 0
  await buildUsageAsync({ cfg: { paths: { project: root } }, accountQuota: quota })
  assert.equal(snapshots, 1)
  snapshots = 0
  const detail = await buildVmDetail({ cfg: { paths: { project: root } }, accountQuota: quota, id: 'vm-b' })
  assert.equal(detail.data.vm.id, 'vm-b')
  assert.equal(snapshots, 1)
  snapshots = 0
  await snapshotAccountPool({ cfg: { paths: { project: root } }, accountQuota: quota, routingConfig: {} })
  assert.equal(snapshots, 1)
})

test('panel reads share one in-flight scan but return independent snapshots', async () => {
  let finish
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  let reads = 0
  const reader = createPanelBillingReader({
    enabled: () => true,
    read: async (job) => {
      reads += 1
      assert.equal(job.method, 'billingStats')
      assert.equal(job.args[0].readOnly, true)
      assert.equal(typeof job.args[0].now, 'number')
      await gate
      return { accounts: [{ account_id: 'a', total_cost: 4 }] }
    },
  })
  const log = {
    billingStats: () => {
      throw Error('writer must not run')
    },
  }
  const a = reader(log, [
    { account_id: 'a', vm_id: 'vm-a' },
    { account_id: 'b', vm_id: 'vm-b' },
  ])
  const b = reader(log, [
    { account_id: 'b', vm_id: 'vm-b' },
    { account_id: 'a', vm_id: 'vm-a' },
  ])
  await new Promise(setImmediate)
  assert.equal(reads, 1)
  finish()
  const [x, y] = await Promise.all([a, b])
  x.accounts[0].total_cost = 999
  assert.equal(y.accounts[0].total_cost, 4)
})

test('billing cache isolates logger, VM/account scope and reset window; expires after completion', async () => {
  let clock = 100_000
  let reads = 0
  const reader = createPanelBillingReader({
    enabled: () => true,
    now: () => clock,
    read: async () => {
      reads += 1
      clock += 1000
      return { reads }
    },
  })
  const a = { billingStats: () => null }
  const b = { billingStats: () => null }
  const window = [{ vm_id: 'vm-a', account_id: 'a', reset_5h: 'x' }]
  assert.equal((await reader(a, window)).reads, 1)
  clock += 9999
  assert.equal((await reader(a, window)).reads, 1)
  clock += 1
  assert.equal((await reader(a, window)).reads, 2)
  assert.equal((await reader(b, window)).reads, 3)
  assert.equal((await reader(a, [{ ...window[0], account_id: 'other' }])).reads, 4)
  assert.equal((await reader(a, [{ ...window[0], reset_5h: 'y' }])).reads, 5)
  assert.equal((await reader(a, [{ ...window[0], vm_id: 'vm-b' }])).reads, 6)
})

test('read pool failure uses old path once and does not cache a failed result', async () => {
  let reads = 0
  let fallback = 0
  const reader = createPanelBillingReader({
    enabled: () => true,
    read: async () => {
      reads += 1
      throw Error('pool unavailable')
    },
  })
  const log = { billingStats: () => ({ fallback: ++fallback }) }
  const [a, b] = await Promise.all([reader(log, []), reader(log, [])])
  assert.deepEqual(a, { fallback: 1 })
  assert.deepEqual(b, a)
  assert.equal((await reader(log, [])).fallback, 2)
  assert.equal(reads, 2)
})
