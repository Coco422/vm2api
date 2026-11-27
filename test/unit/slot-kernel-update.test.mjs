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

test('remote topology accepts tenant scheduling pause only with a physically running unpaused Docker slot', async () => {
  const { inspectWrapUpdateTopology } = await import('../../src/lib/cluster/remote-slot.mjs')
  const id = 'vm-fixture'
  const vm = {
    id,
    node_id: 'node-fixture',
    platform: 'anthropic',
    status: 'paused',
    schedule_off: true,
    schedule_off_reason: 'tenant_paused',
    runtime: { container: 'slot' },
  }
  const before = structuredClone(vm)
  const root = '/fixture/vms/' + id
  const slot = {
    Id: 'same-slot',
    Config: { Cmd: ['/opt/kin-live/kin-kernel'], Labels: { 'kin.vm.id': id } },
    HostConfig: { NetworkMode: 'private', Memory: 3 * 2 ** 30, MemorySwap: 5 * 2 ** 30 },
    State: { Status: 'running', Running: true, Paused: false },
    Mounts: [
      { Type: 'bind', Source: root + '/slot-bin', Destination: '/opt/kin-live', RW: false },
      { Type: 'bind', Source: root + '/run', Destination: '/run/kin' },
    ],
    NetworkSettings: { Networks: { private: { IPAddress: '192.0.2.5', IPAMConfig: { IPv4Address: '192.0.2.5' } } } },
  }
  const helper = {
    Id: 'same-helper',
    Config: { Labels: { 'kin.egress.vm': id } },
    HostConfig: { NetworkMode: 'host' },
    State: { Running: true, StartedAt: 'fixture' },
  }
  const ops = {
    sessionFor: async () => ({ host: { root: '/fixture' } }),
    inspect: async (_, name) => (name === 'slot' ? slot : helper),
    inspectNetwork: async () => ({ Driver: 'bridge', Id: 'fixed' }),
    readConfig: async () =>
      JSON.stringify({ vm_id: id, claude_bin: '/opt/kin-live/cli-node', dataplane: 'wrap', slots_per_worker: 2 }),
  }
  assert.equal((await inspectWrapUpdateTopology(vm, {}, ops)).running, true)
  assert.deepEqual(vm, before)
  for (const patch of [{ schedule_off: false }, { schedule_off_reason: 'operator' }, { status: 'stopped' }]) {
    await assert.rejects(inspectWrapUpdateTopology({ ...vm, ...patch }, {}, ops), /topology_unsupported/)
  }
  for (const state of [
    { Status: 'paused', Running: true, Paused: true },
    { Status: 'running', Running: true, Paused: true },
    { Status: 'exited', Running: false, Paused: false },
    { Status: 'exited', Running: true, Paused: false },
  ]) {
    slot.State = state
    await assert.rejects(inspectWrapUpdateTopology(vm, {}, ops), /topology_unsupported/)
  }
})

test('remote controller rejects mismatched local config bytes and capacity before publishing or restarting', async (t) => {
  const fs = await import('node:fs/promises'),
    path = await import('node:path'),
    os = await import('node:os'),
    crypto = await import('node:crypto')
  const { expectedKernelSlots } = await import('../../src/lib/transport/rust-kernel-supervisor.mjs')
  const { slotExec } = await import('../../src/lib/vm/slot-runtime.mjs')
  const f = fixture()
  f.args.project = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-config-drift-'))
  t.after(() => fs.rm(f.args.project, { recursive: true, force: true }))
  f.args.vm.node_id = 'node'
  const dir = path.join(f.args.project, 'vms', f.args.vm.id, 'run')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'kernel.json'), '{}')
  const wanted = expectedKernelSlots(slotExec(f.args.project, f.args.vm))
  const digest = crypto.createHash('sha256').update('{}').digest('hex')
  for (const [slots, configSha] of [
    [wanted, '0'.repeat(64)],
    [wanted + 1, digest],
  ]) {
    f.ops.inspect = async () => ({ running: true, slots, configSha })
    f.ops.health = async () => ({ ok: true, ready_slots: slots, closed_slots: 0 })
    assert.equal((await f.run()).code, 'slot_kernel_config_drift')
  }
  assert.ok(!f.calls.includes('publish'))
  assert.ok(!f.calls.includes('restart'))
})
