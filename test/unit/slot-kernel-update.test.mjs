import test from 'node:test'
import assert from 'node:assert/strict'
import { updateSlotKernel } from '../../src/lib/vm/slot-kernel-update.mjs'

function fixture(options = {}) {
  const vm = { id: 'vm-fixture', status: options.running === false ? 'stopped' : 'running' }
  const topology = {
    id: 'unchanged-container',
    slots: 2,
    memory: 3 * 2 ** 30,
    swap: 5 * 2 ** 30,
    running: vm.status === 'running',
  }
  const calls = []
  const args = {
    vm,
    project: '/fixture',
    routing: {},
    watchdog: { hold() {}, release() {} },
    poolScheduler: { vmInflight: new Map() },
  }
  const ops = {
    inspect: async () => topology,
    current: () => vm,
    maintenance: async ({ operation }) => {
      calls.push('hold')
      try {
        return await operation()
      } finally {
        calls.push('release')
      }
    },
    health: async () => ({ ok: true, ready_slots: topology.slots, closed_slots: 0 }),
    publish: async () => {
      calls.push('publish')
      return { ok: true, wrap: { pushed: true } }
    },
    restart: async () => {
      calls.push('restart')
      return { ok: true }
    },
    block: () => calls.push('block'),
    ...options.ops,
  }
  return { calls, run: () => updateSlotKernel(args, ops), args, ops }
}
test('active slot publishes and restarts under a single hold', async () => {
  const f = fixture()
  assert.equal((await f.run()).ok, true)
  assert.deepEqual(f.calls, ['hold', 'publish', 'restart', 'release'])
})
test('stopped slot publishes without starting it', async () => {
  const f = fixture({ running: false })
  assert.equal((await f.run()).restarted, false)
  assert.deepEqual(f.calls, ['publish'])
})
test('unknown health, active work, wrong topology and timeout prevent publication', async () => {
  for (const ops of [
    { health: async () => ({ ok: true }) },
    { health: async () => ({ ok: true, ready_slots: 1, closed_slots: 0, queued: 1 }) },
    {
      inspect: async () => {
        throw new Error('slot_update_topology_unsupported')
      },
    },
    { maintenance: async () => ({ ok: false, code: 'slot_drain_timeout' }) },
  ]) {
    const f = fixture({ ops })
    assert.equal((await f.run()).ok, false)
    assert.ok(!f.calls.includes('publish'))
    assert.ok(!f.calls.includes('restart'))
  }
})
test('partial publication or failed restart blocks scheduling before releasing hold', async () => {
  for (const key of ['publish', 'restart']) {
    const f = fixture()
    f.ops[key] = async () => ({ ok: false })
    assert.equal((await f.run()).ok, false)
    assert.deepEqual(f.calls.slice(-2), ['block', 'release'])
  }
})
