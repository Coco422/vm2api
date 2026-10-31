import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { tenantPanelPayload, tenantProxyView } from '../../src/company/tenant-panel-privacy.mjs'
import { servePoolSeatStream } from '../../src/lib/admin/pool-seat-stream.mjs'

test('a blocked or disabled private exit is never reported as healthy', () => {
  for (const proxy of [
    { status: 'ok', enabled: false },
    { status: 'ok', enabled: true, blocked_reason: 'private-provider-policy' },
  ]) {
    const safe = tenantProxyView(proxy)
    assert.equal(safe.status, 'dead')
    assert.doesNotMatch(JSON.stringify(safe), /private-provider-policy/)
  }
})

test('tenant log/filter names and embedded exit errors cannot expose supplier metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-exit-privacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-03',
    owner_user_id: 'u1',
    name: 'claude',
    proxy: {
      id: 'px-private',
      host: 'supplier.example',
      username: 'private-user',
      password: 'private-password',
    },
  }
  fs.writeFileSync(path.join(root, 'vms/vm-03.json'), JSON.stringify(vm))
  const payload = {
    items: [
      {
        vmId: 'vm-03',
        vmName: vm.name,
        totalCost: 1.25,
        requests: 4,
        model: 'claude-sonnet',
        errorMessage: 'SOCKS supplier.example via px-private as private-user: private-password',
      },
    ],
    vms: [{ id: 'vm-03', name: vm.name }],
    debug: 'http://encoded:secret%2Bpass@supplier.example:10007',
  }
  const safe = tenantPanelPayload(payload, { projectRoot: root, ownerUserId: 'u1' })
  assert.equal(safe.items[0].vmName, 'vm-03')
  assert.equal(safe.vms[0].name, 'vm-03')
  assert.equal(safe.items[0].totalCost, 1.25)
  assert.equal(safe.items[0].requests, 4)
  assert.equal(safe.items[0].model, 'claude-sonnet')
  assert.doesNotMatch(JSON.stringify(safe), /supplier|private-user|private-password|px-private|secret%2Bpass|10007/)
  assert.equal(payload.items[0].vmName, vm.name, 'projection must not rewrite stored logs or admin data')
})

test('tenant live stream keeps exit health while removing proxy IDs and raw errors', () => {
  const original = { id: 'px-supplier', status: 'ok', enabled: true, last_error: 'supplier.example:10007' }
  for (const tenant of [true, false]) {
    const req = new EventEmitter(),
      res = new EventEmitter(),
      proxyPool = new EventEmitter()
    const frames = []
    res.write = (s) => frames.push(s)
    proxyPool.liveStatusByVm = () => ({ 'vm-03': original, 'vm-other': original })
    servePoolSeatStream({
      req,
      res,
      getScheduler: () => null,
      proxyPool,
      writeSSEHeaders() {},
      visibleVmIds: tenant ? () => new Set(['vm-03']) : null,
    })
    req.emit('close')
    const frame = JSON.parse(frames.find((s) => s.startsWith('event: proxy')).split('data: ')[1])
    assert.equal(frame.proxies['vm-03'].status, 'ok')
    if (tenant) {
      assert.equal(frame.proxies['vm-other'], undefined)
      assert.doesNotMatch(JSON.stringify(frame), /supplier|10007/)
    } else assert.deepEqual(frame.proxies['vm-03'], original)
  }
})
