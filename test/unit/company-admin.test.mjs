import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

test('admin assigns VM and policy; tenant creates own key; ownership survives restart', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'company-admin-'))
  fs.mkdirSync(path.join(sandbox, 'data'))
  fs.mkdirSync(path.join(sandbox, 'site/web/dist'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'site/web/dist/index.html'), '<html>fixture</html>')
  const { startSandbox } = await import('../../scripts/company-sandbox.mjs')
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const start = () => startSandbox({ root, sandbox, record() {}, port: 0, installSignals: false })
  let fixture
  let token
  const request = (method, route, body, auth = token) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: fixture.server.address().port,
          method,
          path: route,
          headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            data += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }))
        },
      )
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  const login = async (username = 'localadmin', password = 'local-admin-8791') => {
    const res = await request('POST', '/api/panel/login', { username, password }, null)
    assert.equal(res.status, 200, JSON.stringify(res))
    assert.ok(res.token)
    token = res.token
  }
  try {
    fixture = await start()
    assert.equal((await request('GET', '/api/panel/users', null, null)).status, 401)
    assert.equal((await request('GET', '/api/panel/users', null, 'sk-vm-local-demo-alice')).status, 401)
    await login()
    for (const route of [
      'me',
      'users',
      'vms',
      'api-keys',
      'routing',
      'dashboard',
      'proxies',
      'vm-pools',
      'test-models',
    ]) {
      const res = await request('GET', `/api/panel/${route}`)
      assert.equal(res.status, 200, `${route}: ${JSON.stringify(res)}`)
    }
    const created = await request('POST', '/api/panel/users', {
      username: 'fixture-employee',
      password: 'local-employee-test-only',
      role: 'user',
      vm_create_quota: 0,
    })
    assert.equal(created.status, 201, JSON.stringify(created))
    const userId = created.data.item.id
    const owner = await request('PATCH', '/api/panel/vms/spare-vm-1/owner', { user_id: userId })
    assert.equal(owner.status, 200, JSON.stringify(owner))
    const listed = await request('GET', '/api/panel/vms')
    assert.equal(listed.data.items.find((vm) => vm.id === 'spare-vm-1').owner_user_id, userId)
    assert.equal(listed.data.items.find((vm) => vm.id === 'spare-vm-1').origin, 'admin_assigned')
    const detail = await request('GET', '/api/panel/vms/spare-vm-1')
    assert.equal(detail.data.vm.owner_user_id, userId)
    const adminToken = token
    await login('fixture-employee', 'local-employee-test-only')
    const tenantToken = token
    const keyRes = await request('POST', '/api/panel/api-keys', { name: 'my-client' })
    assert.equal(keyRes.status, 201, JSON.stringify(keyRes))
    const key = keyRes.item
    assert.equal(key.user_id, userId)
    let me = await request('GET', '/api/company/me', null, key.key)
    assert.equal(me.status, 200, JSON.stringify(me))
    assert.deepEqual(
      me.data.vms.map((vm) => vm.id),
      ['spare-vm-1'],
    )
    const renamed = await request('PATCH', `/api/panel/api-keys/${key.id}`, { name: 'renamed-client' })
    assert.equal(renamed.status, 200)
    assert.equal((await request('PATCH', `/api/panel/api-keys/${key.id}`, { quota_usd: 100 })).status, 403)
    token = adminToken
    assert.equal((await request('POST', `/api/panel/api-keys/${key.id}/reveal`, {})).status, 404)
    const adminKeys = await request('GET', '/api/panel/api-keys')
    assert.equal(
      adminKeys.keys.some((item) => item.id === key.id),
      false,
    )
    const policy = await request('PATCH', '/api/panel/vms/spare-vm-1', { max_concurrency: 3, max_rpm: 30 })
    assert.equal(policy.status, 200, JSON.stringify(policy))
    assert.equal(policy.ok, true)
    const vmFile = path.join(fixture.project, 'vms/spare-vm-1.json')
    assert.equal(JSON.parse(fs.readFileSync(vmFile)).policy.maxConcurrency, 3)
    assert.equal((await request('PATCH', '/api/panel/vms/spare-vm-1', { memory_mb: 2048 })).status, 400)
    assert.equal((await request('PATCH', '/api/panel/vms/spare-vm-1', { max_concurrency: -1 })).status, 400)
    for (const route of [
      '/api/panel/vms/spare-vm-1/start',
      '/api/panel/vms/spare-vm-1/auth',
      '/api/panel/update',
      '/admin/reload',
    ]) {
      assert.equal((await request('POST', route, {})).status, 409)
    }
    await request('PATCH', '/api/panel/users/alice', { enabled: false })
    await fixture.close()
    fixture = null
    fixture = await start()
    await login()
    me = await request('GET', '/api/company/me', null, key.key)
    assert.equal(me.status, 200)
    const tenantKeys = await request('GET', '/api/panel/api-keys', null, tenantToken)
    assert.equal(tenantKeys.keys.find((item) => item.id === key.id)?.name, 'renamed-client')
    assert.deepEqual(
      me.data.vms.map((vm) => vm.id),
      ['spare-vm-1'],
    )
    const saved = JSON.parse(fs.readFileSync(vmFile))
    assert.equal(saved.owner_user_id, userId)
    assert.equal(saved.policy.maxConcurrency, 3)
    assert.equal(saved.policy.maxRpm, 30)
    assert.equal((await request('GET', '/api/company/me', null, 'sk-vm-local-demo-alice')).status, 401)
  } finally {
    if (fixture) await fixture.close()
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})
