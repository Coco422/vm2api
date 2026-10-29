import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { evaluateAudit, AUDIT_SITES } from '../../src/lib/vm/egress-audit-rules.mjs'
import { createEgressAuditService } from '../../src/lib/admin/vm-egress-audit.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
)
function good() {
  return {
    'net-coffee': {
      complete: true,
      ip: '203.0.113.7',
      score: '90 极度纯净',
      dns: { complete: true, green: true, warning: false, ips: ['1.1.1.1'] },
      webrtc: { complete: true, green: true, warning: false, ips: ['203.0.113.7'] },
    },
    ping0: {
      complete: true,
      ip: '203.0.113.7',
      purity_green: true,
      ai_green: true,
      purity_text: '纯净',
      ai_text: '适用',
    },
    'fuck-claude': { complete: true, score: '29' },
  }
}
test('four criteria use inclusive 90 and exclusive 30 thresholds', () => {
  assert.equal(evaluateAudit(good()).status, 'pass')
  for (const [trust, risk, expected] of [
    [89, 29, 'fail'],
    [90, 30, 'fail'],
    [100, 0, 'pass'],
    [90, 29.99, 'pass'],
  ]) {
    const data = good()
    data['net-coffee'].score = trust
    data['fuck-claude'].score = risk
    assert.equal(evaluateAudit(data).status, expected)
  }
})
test('initial zero, empty/invalid scores, failed probes and green without observations never pass', () => {
  assert.equal(evaluateAudit().status, 'unknown')
  for (const value of ['', null, false, -1, 101, 'NaN', '90abc']) {
    const data = good()
    data['net-coffee'].score = value
    assert.equal(evaluateAudit(data).results[0].status, 'unknown')
  }
  for (const probe of ['dns', 'webrtc']) {
    const data = good()
    data['net-coffee'][probe].ips = []
    assert.equal(evaluateAudit(data).results[1].status, 'unknown')
    data['net-coffee'][probe].warning = true
    assert.equal(evaluateAudit(data).results[1].status, 'fail')
  }
  const initial = good()
  initial['fuck-claude'] = { complete: false, score: 0 }
  assert.equal(evaluateAudit(initial).results[3].status, 'unknown')
})
test('Ping0 missing fields and divergent exits cannot certify one exit', () => {
  const data = good()
  data.ping0.ai_green = null
  assert.equal(evaluateAudit(data).results[2].status, 'unknown')
  data.ping0.ai_green = false
  assert.equal(evaluateAudit(data).results[2].status, 'fail')
  data.ping0.ai_green = true
  data.ping0.ip = '203.0.113.8'
  assert.equal(evaluateAudit(data).status, 'fail')
  assert.equal(evaluateAudit(data).exit_consistent, false)
  const udp = good()
  udp['net-coffee'].webrtc.ips = ['203.0.113.8']
  assert.equal(evaluateAudit(udp).results[1].status, 'fail')
})
async function fixture(t, execute) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-audit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vm = {
    id: 'vm-01',
    proxy: { id: 'px-test', host: '127.0.0.1', port: 1080, password: 'private-proxy-test' },
    timezone: 'UTC',
    runtime: { type: 'docker', container: 'kin-01' },
  }
  const options = { projectRoot: dir, dataDir: dir, readVm: (_, id) => (id === vm.id ? vm : null), execute }
  return { dir, vm, options, service: createEgressAuditService(options) }
}
async function completed(service) {
  for (let i = 0; i < 100; i++) {
    const report = service.list('vm-01').reports[0]
    if (report.state !== 'running') return report
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('fixture audit did not finish')
}
const emitGood = async (_vm, emit) => {
  for (const site of AUDIT_SITES)
    emit({
      kind: 'site',
      site: site.id,
      observation: good()[site.id],
      screenshot: png.toString('base64'),
      ...(site.id === 'net-coffee' ? { leaks_screenshot: png.toString('base64') } : {}),
    })
}
test('persists authenticated evidence, keeps credentials private, and invalidates changed configurations', async (t) => {
  const { vm, service, options } = await fixture(t, emitGood)
  const started = service.start(vm.id)
  const report = await completed(service)
  assert.equal(report.state, 'completed')
  assert.equal(report.verdict, 'pass')
  assert.equal(JSON.stringify(report).includes('private-proxy-test'), false)
  assert.deepEqual(service.screenshot(vm.id, started.id, 'ping0'), png)
  assert.deepEqual(service.screenshot(vm.id, started.id, 'net-coffee-leaks'), png)
  assert.equal(report.evidence_complete, true)
  assert.throws(() => service.screenshot(vm.id, started.id, '../report'), { code: 'audit_not_found' })
  assert.throws(() => service.list('../vm-01'), { code: 'invalid_audit_id' })
  const restarted = createEgressAuditService(options)
  assert.equal(restarted.list(vm.id).reports[0].verdict, 'pass')
  vm.proxy.host = '127.0.0.2'
  const stale = restarted.list(vm.id).reports[0]
  assert.equal(stale.stale, true)
  assert.equal(stale.verdict, 'unknown')
})
test('single flight, crash recovery, missing screenshots and execution errors fail closed', async (t) => {
  let release
  const { vm, service, options } = await fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  service.start(vm.id)
  assert.throws(() => service.start(vm.id), { code: 'audit_running' })
  const restarted = createEgressAuditService(options)
  assert.equal(restarted.list(vm.id).reports[0].state, 'interrupted')
  release()
  assert.equal((await completed(service)).verdict, 'unknown')
  const missingImage = createEgressAuditService({
    ...options,
    execute: async (_vm, emit) => {
      for (const site of AUDIT_SITES)
        emit({ kind: 'site', site: site.id, observation: good()[site.id], screenshot: 'invalid' })
    },
  })
  missingImage.start(vm.id)
  assert.equal((await completed(missingImage)).verdict, 'unknown')
  const failing = createEgressAuditService({
    ...options,
    execute: async () => {
      throw new Error('secret-value')
    },
  })
  failing.start(vm.id)
  const error = await completed(failing)
  assert.equal(error.state, 'error')
  assert.equal(error.verdict, 'unknown')
  assert.equal(JSON.stringify(error).includes('secret-value'), false)
})
test('unbound or unknown VMs cannot start; history retains only five owned reports', async (t) => {
  const { vm, service } = await fixture(t, emitGood)
  assert.throws(() => service.start('vm-unknown'), { code: 'vm_not_found' })
  for (let i = 0; i < 7; i++) {
    service.start(vm.id)
    await completed(service)
  }
  assert.equal(service.list(vm.id).reports.length, 5)
  vm.proxy = null
  assert.throws(() => service.start(vm.id), { code: 'audit_proxy_required' })
})
test('report, execution and screenshots are admin-only', () => {
  for (const role of ['user', 'super']) {
    assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/egress-audit', role).ok, false)
    assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/egress-audit', role).ok, false)
    assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/egress-audit/job/screenshots/ping0', role).ok, false)
  }
})

test('sandbox compatibility is explicit, validated and recorded per task', async (t) => {
  const modes = []
  const { vm, service } = await fixture(t, async (vm, emit, options) => {
    modes.push(options.noSandbox)
    await emitGood(vm, emit)
  })
  assert.throws(() => service.start(vm.id, { noSandbox: 'true' }), { code: 'invalid_audit_mode' })
  service.start(vm.id)
  assert.equal((await completed(service)).browser_sandbox, true)
  service.start(vm.id, { noSandbox: true })
  assert.equal((await completed(service)).browser_sandbox, false)
  service.start(vm.id, { noSandbox: false })
  assert.equal((await completed(service)).browser_sandbox, true)
  assert.deepEqual(modes, [false, true, false])
})

test('panel routes return 202, enforce admin auth and stream protected PNGs', async (t) => {
  const { service, dir, vm } = await fixture(t, emitGood)
  const json = (res, status, body) => Object.assign(res, { status, body })
  const handler = createPanelHandler({
    cfg: { paths: { project: dir, data: dir } },
    egressAudit: service,
    json,
    readBody: async (req) => {
      if (req.auditBody === 'invalid-json') throw new SyntaxError()
      return req.auditBody
    },
    requireAuth: (req, res) => {
      if (!req.panelUser) {
        json(res, 401, {})
        return false
      }
      return true
    },
  })
  const request = async (method, pathname, role = 'admin', auditBody = undefined) => {
    const req = {
      method,
      url: pathname,
      headers: auditBody === undefined ? {} : { 'content-length': '16' },
      auditBody,
      ...(role ? { panelUser: 'test-admin', panelRole: role } : {}),
    }
    const res = {
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        this.content = body
      },
    }
    await handler(req, res, new URL(pathname, 'http://127.0.0.1'))
    return res
  }
  const base = `/api/panel/vms/${vm.id}/egress-audit`
  assert.equal((await request('POST', base, null)).status, 401)
  assert.equal((await request('POST', base, 'super')).status, 403)
  const started = await request('POST', base)
  assert.equal(started.status, 202)
  await completed(service)
  const listed = await request('GET', base)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.data.reports[0].verdict, 'pass')
  const shot = `${base}/${started.body.data.id}/screenshots/net-coffee`
  assert.equal((await request('GET', shot, 'user')).status, 403)
  const image = await request('GET', shot)
  assert.equal(image.status, 200)
  assert.equal(image.headers['cache-control'], 'private, no-store')
  assert.deepEqual(image.content, png)
  assert.equal((await request('POST', base, 'admin', { no_sandbox: 'true' })).status, 400)
  assert.equal((await request('POST', base, 'admin', [])).status, 400)
  assert.equal((await request('POST', base, 'admin', 'invalid-json')).status, 400)
  assert.equal((await request('POST', base, 'admin', { no_sandbox: true })).status, 202)
  assert.equal((await completed(service)).browser_sandbox, false)
})

test('legacy three-image reports require the independent DNS/WebRTC screenshot', async (t) => {
  const { vm, service, options, dir } = await fixture(t, emitGood)
  service.start(vm.id)
  const report = await completed(service)
  const file = path.join(dir, 'egress-audits', vm.id, report.id, 'report.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete stored.sites['net-coffee'].leaks_screenshot
  fs.writeFileSync(file, JSON.stringify(stored))
  const old = createEgressAuditService(options).list(vm.id).reports[0]
  assert.equal(old.evidence_complete, false)
  assert.equal(old.verdict, 'unknown')
  assert.throws(() => service.screenshot(vm.id, report.id, 'net-coffee-leaks'), { code: 'audit_not_found' })
})
