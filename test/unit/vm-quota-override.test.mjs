import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { evaluateAccount } from '../../src/lib/pool/availability.mjs'
import { keepTenantExactGates, parseVmQuotaOverride, vmQuotaOverrideOf } from '../../src/lib/pool/vm-quota-override.mjs'
import { mergeTenantVmQuotaThresholds } from '../../src/company/tenant-vm-quota.mjs'

function quota() {
  return new AccountQuota({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-quota-')),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: { default: { limit_5h: 0.85, limit_7d: 0.8, max_concurrency: 4 } },
    },
    accounts: [
      { account_id: 'acc-a', vm_id: 'vm-a' },
      { account_id: 'acc-b', vm_id: 'vm-b' },
    ],
  })
}

function setUtil(q, accountId, u5, u7 = 0.1) {
  q.ingestHeaders(
    accountId,
    {
      'anthropic-ratelimit-unified-5h-utilization': String(u5),
      'anthropic-ratelimit-unified-7d-utilization': String(u7),
      'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 3600_000).toISOString(),
    },
    {},
  )
}

test('VM 5h threshold override only moves that VM gate', () => {
  const q = quota()
  q.setVmQuotaOverride('vm-a', { limit_5h: 0.95 })
  setUtil(q, 'acc-a', 0.9)
  setUtil(q, 'acc-b', 0.9)
  assert.equal(q.canAccept('acc-a').ok, true)
  assert.equal(q.canAccept('acc-b').reason, 'quota_5h_safety')
})

test('VM block switch off lets the slot run past its threshold; clearing restores global', () => {
  const q = quota()
  setUtil(q, 'acc-a', 0.9)
  q.setVmQuotaOverride('vm-a', { block_on_5h: false })
  assert.equal(q.canAccept('acc-a').ok, true)
  q.setVmQuotaOverride('vm-a', null)
  assert.equal(q.canAccept('acc-a').reason, 'quota_5h_safety')
})

test('tenant activation enforces each selected limit at 95% with global switches off and 5% overshoot', () => {
  const q = quota()
  Object.assign(q.config, { block_on_5h: false, block_on_7d: false, gate_overshoot: 0.05 })
  const stored = mergeTenantVmQuotaThresholds({ limit_5h: 0.95 }, { block_on_5h: true, limit_7d: 0.95 }).value
  const read = vmQuotaOverrideOf({ policy: { quota: stored } })
  assert.deepEqual(read, stored)
  q.setVmQuotaOverride('vm-a', read)
  setUtil(q, 'acc-a', 0.949, 0.949)
  assert.equal(q.canAccept('acc-a').ok, true)
  assert.equal(q.gateZoneOf('acc-a'), 'draining')
  setUtil(q, 'acc-a', 0.95, 0.1)
  assert.equal(q.canAccept('acc-a').reason, 'quota_5h_safety')
  const view = (u5, u7) => evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    policy: q.policyFor({ vm_id: 'vm-a' }),
    quota: { utilization_5h: u5, utilization_7d: u7 },
  })
  assert.equal(view(0.95, 0.1).reason, 'quota_5h_safety')
  setUtil(q, 'acc-a', 0.1, 0.95)
  assert.equal(q.canAccept('acc-a').reason, 'quota_7d_safety')
  assert.equal(view(0.1, 0.95).reason, 'quota_7d_safety')
  assert.equal(q.gateZoneOf('acc-a'), 'gated')
  setUtil(q, 'acc-b', 0.95, 0.95)
  assert.equal(q.canAccept('acc-b').ok, true)
  const edited = keepTenantExactGates(stored, { limit_5h: 0.95, block_on_5h: true, block_on_7d: false })
  assert.equal(edited.tenant_exact_5h, true)
  assert.equal(edited.tenant_exact_7d, undefined)
  q.setVmQuotaOverride('vm-a', edited)
  assert.equal(q.canAccept('acc-a').ok, true)
})

test('parseVmQuotaOverride rejects out-of-range and unknown fields, null field follows global', () => {
  assert.deepEqual(parseVmQuotaOverride({ limit_5h: 0.9, limit_7d: null }), {
    ok: true,
    value: { limit_5h: 0.9 },
  })
  assert.deepEqual(parseVmQuotaOverride({ limit_5h: null }), { ok: true, value: null })
  assert.equal(parseVmQuotaOverride({ limit_5h: 0.2 }).ok, false)
  assert.equal(parseVmQuotaOverride({ limit_7d: 1.5 }).ok, false)
  assert.equal(parseVmQuotaOverride({ block_on_5h: 'yes' }).ok, false)
  assert.equal(parseVmQuotaOverride({ max_concurrency: 4 }).ok, false)
})

test('stored session window fields are ignored on read', () => {
  assert.deepEqual(vmQuotaOverrideOf({ policy: { quota: { limit_5h: 0.9, max_sessions: 2, session_idle_min: 5 } } }), {
    limit_5h: 0.9,
  })
  assert.equal(parseVmQuotaOverride({ max_sessions: 1 }).ok, false)
})
