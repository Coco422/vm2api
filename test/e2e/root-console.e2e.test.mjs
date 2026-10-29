import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedVm, startGateway } from '../harness.mjs'

test('root redirects to the console while legacy entries and health remain available', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-root-console-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const vm = seedVm({ project, oauth: false })
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify({ ...vm, status: 'stopped' }))
  fs.mkdirSync(path.join(project, 'config'))
  fs.writeFileSync(
    path.join(project, 'config', 'routing.json'),
    JSON.stringify({ kernel_watchdog: { enabled: false }, credential_refresh: { enabled: false } }),
  )
  const gw = await startGateway({ project, env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const dist = path.join(gw.project, 'web', 'dist')
    fs.mkdirSync(dist, { recursive: true })
    const html = '<!doctype html><title>native console</title>'
    fs.writeFileSync(path.join(dist, 'index.html'), html)
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(gw.baseUrl + '/', { method, redirect: 'manual' })
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), '/cc')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(await response.text(), '')
    }
    for (const entry of ['/cc', '/cc/', '/console', '/console/']) {
      const response = await fetch(gw.baseUrl + entry)
      assert.equal(response.status, 200, entry)
      assert.equal(await response.text(), html, entry)
    }
    const followed = await fetch(gw.baseUrl + '/')
    assert.equal(followed.url, gw.baseUrl + '/cc')
    assert.equal(await followed.text(), html)
    for (const entry of ['/health', '/healthz']) {
      const response = await fetch(gw.baseUrl + entry)
      assert.equal(response.status, 200, entry)
      assert.equal((await response.json()).status, 'ok')
    }
    const legacyEmployee = await fetch(gw.baseUrl + '/api/company/me')
    assert.equal(legacyEmployee.status, 404)
    const denied = await fetch(gw.baseUrl + '/api/panel/me')
    assert.equal(denied.status, 401)
  } finally {
    await gw.stop()
  }
})
