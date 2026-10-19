import test from 'node:test'
import assert from 'node:assert/strict'
import {
  legacyServiceContainerBody,
  migrateRemoteContainer,
  needsLegacyServiceMigration,
} from '../../src/lib/cluster/remote-slot.mjs'

const oldSlot = {
  Id: 'old-slot-id',
  State: { Running: true },
  Config: {
    Image: 'vm2api/kin-slot-ubuntu:old',
    User: '1000:1000',
    Cmd: ['/opt/kin/kin-kernel', '--gateway-worker', '--config', '/run/kin/kernel.json'],
    Labels: { 'kin.vm': '1', 'kin.vm.layout': '2' },
  },
  HostConfig: {
    Binds: ['/srv/vm-05/run:/run/kin', '/srv/vm-05/old-worker:/usr/local/bin/kin-worker'],
    NetworkMode: 'kin-05-net',
    ReadonlyRootfs: true,
    RestartPolicy: { Name: 'unless-stopped' },
  },
  NetworkSettings: { Networks: { 'kin-05-net': { IPAddress: '172.20.0.2', Aliases: ['kin-05'] } } },
  Mounts: [{ Destination: '/run/kin', Source: '/srv/vm-05/run', RW: true }],
}

test('legacy container body replaces old service bind and preserves slot settings', () => {
  const body = legacyServiceContainerBody(oldSlot, {
    sourceDir: '/srv/vm-05/slot-bin',
    removeDestinations: ['/usr/local/bin/kin-worker'],
    layout: true,
  })
  assert.equal(body.Image, oldSlot.Config.Image)
  assert.equal(body.User, oldSlot.Config.User)
  assert.equal(body.Labels['kin.vm.layout'], '3')
  assert.deepEqual(body.HostConfig.Binds, ['/srv/vm-05/run:/run/kin', '/srv/vm-05/slot-bin:/opt/kin-live:ro'])
  assert.deepEqual(body.NetworkingConfig.EndpointsConfig['kin-05-net'].IPAMConfig, { IPv4Address: '172.20.0.2' })
  assert.equal(needsLegacyServiceMigration(oldSlot, { sourceDir: '/srv/vm-05/slot-bin' }), true)
})

test('legacy egress command points at the persistent service mount', () => {
  const body = legacyServiceContainerBody(oldSlot, {
    sourceDir: '/srv/vm-05/slot-bin',
    removeDestinations: ['/usr/local/bin/kin-egress'],
    command: ['/opt/kin-live/kin-egress', '-config', '/etc/kin-egress/egress.json'],
  })
  assert.deepEqual(body.Cmd, ['/opt/kin-live/kin-egress', '-config', '/etc/kin-egress/egress.json'])
})

test('migration keeps the old container as a stopped rollback copy', async () => {
  const state = new Map([['kin-05', structuredClone(oldSlot)]])
  let sequence = 0
  const inspect = async (_docker, name) => state.get(name) || null
  const action = async (_docker, name, operation) => {
    const value = [...state.values()].find((item) => item.Id === name) || state.get(name)
    if (operation === 'stop') value.State.Running = false
    if (operation === 'start') value.State.Running = true
  }
  const rename = async (_docker, from, to) => {
    const value = state.get(from)
    state.delete(from)
    state.set(to, value)
  }
  const create = async (_docker, name, body) => {
    const id = `new-${++sequence}`
    state.set(name, { Id: id, State: { Running: false }, Config: body, Mounts: [{ Destination: '/opt/kin-live', RW: false }] })
    return id
  }
  const result = await migrateRemoteContainer(
    {},
    'kin-05',
    legacyServiceContainerBody(oldSlot, { sourceDir: '/srv/vm-05/slot-bin', layout: true }),
    { wasRunning: true, ops: { inspect, action, rename, create } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.action, 'migrated')
  assert.equal(state.get('kin-05').State.Running, true)
  assert.equal(state.get(result.backup).State.Running, false)
})
