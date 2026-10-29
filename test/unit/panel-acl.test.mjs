import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizePanelRoute, viewsForRole, hasCapability, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const serverSrc = [
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/admin/panel-routes.mjs'),
    'utf8',
  ),
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.mjs'), 'utf8'),
].join('\n')

test('user sees owned VMs, keys, logs and statistics', () => {
  assert.deepEqual(viewsForRole('user'), ['vm', 'keys', 'logs', 'statistics'])
  assert.deepEqual(viewsForRole('super'), ['overview', 'cluster', 'logs', 'statistics', 'vm'])
  assert.equal(canViewPage('admin', 'statistics'), true)
  assert.equal(canViewPage('user', 'vm'), true)
  assert.equal(canViewPage('user', 'overview'), false)
  assert.equal(canViewPage('super', 'vm'), true)
  assert.equal(canViewPage('admin', 'users'), true)
  assert.equal(canViewPage('admin', 'api'), true)
  assert.equal(canViewPage('admin', 'system'), true)
  assert.equal(canViewPage('user', 'api'), false)
  assert.equal(canViewPage('admin', 'database'), true)
  assert.equal(canViewPage('super', 'database'), false)
  assert.equal(canViewPage('user', 'database'), false)
  assert.equal(hasCapability('super', 'vm.schedule'), true)
  assert.equal(hasCapability('user', 'vm.schedule'), false)
})

test('tenant reads usage and its client keys; all management stays admin-only', () => {
  for (const path of [
    '/api/panel/vms',
    '/api/panel/vms/vm-01',
    '/api/panel/api-keys',
    '/api/panel/api-keys/key_a/stats',
    '/api/panel/request-logs',
  ])
    assert.equal(authorizePanelRoute('GET', path, 'user').ok, true, path)
  const denied = [
    ['GET', '/api/panel/vms/create-options'],
    ['POST', '/api/panel/vms/create'],
    ['POST', '/api/panel/vms/import'],
    ['POST', '/api/panel/vms/package'],
    ['GET', '/api/panel/vms/vm-01/package'],
    ['PUT', '/api/panel/vms/vm-01/package'],
    ['GET', '/api/panel/vms/vm-01/oauth/credential'],
    ['PUT', '/api/panel/vms/vm-01/oauth/credential'],
    ['POST', '/api/panel/vms/vm-01/oauth/refresh'],
    ['POST', '/api/panel/vms/vm-01/start'],
    ['POST', '/api/panel/vms/vm-01/stop'],
    ['POST', '/api/panel/vms/vm-01/recover'],
    ['POST', '/api/panel/vms/vm-01/schedulable'],
    ['POST', '/api/panel/vms/vm-01/cooldown/clear'],
    ['PATCH', '/api/panel/vms/vm-01'],
    ['DELETE', '/api/panel/vms/vm-01'],
    ['GET', '/api/panel/proxies'],
    ['POST', '/api/panel/proxies/px/reveal'],
    ['POST', '/api/panel/api-keys'],
    ['PATCH', '/api/panel/api-keys/key_a'],
    ['DELETE', '/api/panel/api-keys/key_a'],
    ['POST', '/api/panel/api-keys/key_a/reset-quota'],
    ['GET', '/api/panel/request-logs/export'],
    ['GET', '/api/panel/users'],
    ['GET', '/api/panel/routing'],
    ['POST', '/api/panel/vms/vm-01/future-management-route'],
  ]
  for (const [method, path] of denied) {
    assert.equal(authorizePanelRoute(method, path, 'user').ok, false, `${method} ${path}`)
    assert.equal(authorizePanelRoute(method, path, 'admin').ok, true, `admin ${method} ${path}`)
  }
})

test('user can query quota and redeem reset credits on owned vms', () => {
  const allowed = [
    '/api/panel/vms/vm-01/openai-quota/refresh',
    '/api/panel/vms/vm-01/openai-quota/reset',
    '/api/panel/vms/vm-01/claude-reset/query',
    '/api/panel/vms/vm-01/claude-reset/redeem',
  ]
  for (const p of allowed) {
    assert.equal(authorizePanelRoute('POST', p, 'user').ok, true, `user POST ${p}`)
    assert.equal(authorizePanelRoute('GET', p, 'user').ok, false, `user GET ${p}`)
    assert.equal(authorizePanelRoute('POST', p, 'super').ok, false, `super POST ${p}`)
  }
  assert.equal(authorizePanelRoute('POST', '/api/panel/api-keys/key_a/reset', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/claude-reset/other', 'user').ok, false)
})

test('only admin can rotate client keys', () => {
  const p = '/api/panel/api-keys/key_a/rotate'
  assert.equal(authorizePanelRoute('POST', p, 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', p, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', p, 'super').ok, false)
})

test('usage-logs and statistics are read-only for user and super', () => {
  const paths = [
    '/api/panel/usage-logs',
    '/api/panel/usage-logs/summary',
    '/api/panel/usage-logs/filter-options',
    '/api/panel/usage-logs/session-suggestions',
    '/api/panel/usage-logs/active-sessions',
    '/api/panel/usage-logs/overview',
    '/api/panel/statistics',
    '/api/panel/statistics/leaderboard',
  ]
  for (const role of ['user', 'super']) {
    for (const p of paths) {
      assert.equal(authorizePanelRoute('GET', p, role).ok, true, `${role} GET ${p}`)
      assert.equal(authorizePanelRoute('POST', p, role).ok, false, `${role} POST ${p}`)
    }
    assert.equal(authorizePanelRoute('GET', '/api/panel/usage-logs/other', role).ok, false)
  }
})

test('super can schedule VMs but cannot touch credentials or delete', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/schedulable', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/cooldown/clear', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/circuit/reset', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/package', 'super').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-01/package', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/package', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/refresh', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/generate-auth-url', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/exchange-code', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/to-setup-token', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/oauth/credential', 'super').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-01/oauth/credential', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/oauth/credential', 'user').ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/create-options', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/version', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/update', 'super').ok, false)
})

test('tenant cannot create or change model test schedules', () => {
  for (const [method, path] of [
    ['GET', '/api/panel/vms/vm-01/test-schedule'],
    ['PUT', '/api/panel/vms/vm-01/test-schedule'],
    ['DELETE', '/api/panel/vms/vm-01/test-schedule'],
    ['GET', '/api/panel/test-schedule/default'],
    ['PUT', '/api/panel/test-schedule/default'],
    ['POST', '/api/panel/test-schedule/sync'],
  ])
    assert.equal(authorizePanelRoute(method, path, 'user').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/test-schedule/default', 'admin').ok, true)
})

test('admin is unrestricted', () => {
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/version', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/update', 'admin').ok, true)
})

test('user and super can GET/PUT onboarding; POST is admin-only', () => {
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('GET', '/api/panel/onboarding', role).ok, true, `${role} GET`)
    assert.equal(authorizePanelRoute('PUT', '/api/panel/onboarding', role).ok, true, `${role} PUT`)
  }
  assert.equal(authorizePanelRoute('POST', '/api/panel/onboarding', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/onboarding', 'super').ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/onboarding', 'user').ok, false)
})

test('onboarding profile writes are admin-only', async () => {
  const { Readable } = await import('node:stream')
  const { readBody } = await import('../../src/lib/http/respond.mjs')
  for (const role of ['user', 'super']) {
    let routingWrites = 0
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: {} },
      readBody,
      persistRoutingPatch() {
        routingWrites += 1
        return {}
      },
      requireAuth(req) {
        req.panelUser = 'alice'
        req.panelRole = role
        return true
      },
      json(_res, status, body) {
        response.status = status
        response.body = body
      },
    })
    const req = Readable.from([Buffer.from(JSON.stringify({ action: 'profile', mode: 'personal' }))])
    req.method = 'PUT'
    await handlePanel(req, {}, new URL('http://localhost/api/panel/onboarding'))
    assert.equal(response.status, 403, role)
    assert.equal(response.body.error.code, 'forbidden', role)
    assert.equal(routingWrites, 0, role)
  }
})

test('managed keys cannot bypass admin role checks through models refresh', async () => {
  let authCalls = 0
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'managed'
      return true
    },
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, true)
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'forbidden')
})

test('admin models refresh stays delegated to the server route', async () => {
  let authCalls = 0
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json() {
      assert.fail('delegated admin refresh must not respond in the panel handler')
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, false)
})

test('ACL schedule POSTs have matching server handlers', () => {
  assert.match(serverSrc, /clearVmCooldown/)
  assert.match(serverSrc, /cooldown\\\/clear/)
  assert.match(serverSrc, /\/schedulable\$/)
})
