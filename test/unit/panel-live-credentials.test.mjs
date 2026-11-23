import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  collectLivePanelCredentials,
  invalidateLiveCredentialCache,
  publicLiveCredential,
} from '../../src/lib/admin/panel-live-credentials.mjs'

function tmpDir(prefix = 'kin-live-cred-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function healthFixture(t) {
  invalidateLiveCredentialCache()
  const project = tmpDir()
  const id = 'vm-live'
  const home = path.join(project, 'vms', id, 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        expiresAt: Date.now() - 3600_000,
      },
    }),
  )
  const socket = path.join(project, 'health.sock')
  let finish
  let seen
  const started = new Promise((resolve) => {
    seen = resolve
  })
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  let requests = 0
  const server = http.createServer(async (_req, res) => {
    requests += 1
    seen()
    await gate
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        ok: true,
        credential: {
          has_access: true,
          has_refresh: true,
          expires_at: Date.now() + 3600_000,
        },
      }),
    )
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  t.after(async () => {
    finish()
    invalidateLiveCredentialCache()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(project, { recursive: true, force: true })
  })
  const vm = { id, status: 'running', runtime: { kernel_socket: socket } }
  fs.writeFileSync(path.join(project, 'vms', id + '.json'), JSON.stringify(vm))
  return { project, vm, finish, started, count: () => requests }
}

test('list background read returns file data immediately and shares one pending health scan', async (t) => {
  const f = await healthFixture(t)
  const first = await collectLivePanelCredentials(f.project, [f.vm], { background: true })
  assert.equal(first.get(f.vm.id).credential_state, 'expired_refreshable')
  await f.started
  await collectLivePanelCredentials(f.project, [f.vm], { background: true })
  assert.equal(f.count(), 1)
  const blocking = collectLivePanelCredentials(f.project, [f.vm])
  f.finish()
  const fresh = await blocking
  assert.equal(fresh.get(f.vm.id).credential_state, 'fresh')
  assert.equal(f.count(), 1)
  assert.equal(JSON.stringify([...fresh]).includes('fixture-access'), false)
})

test('credential cache cannot reuse another project or filtered VM collection; stopped VMs are not probed', async (t) => {
  const f = await healthFixture(t)
  f.finish()
  await collectLivePanelCredentials(f.project, [f.vm])
  assert.equal((await collectLivePanelCredentials(f.project, [])).size, 0)
  const other = tmpDir()
  t.after(() => fs.rmSync(other, { recursive: true, force: true }))
  const missing = await collectLivePanelCredentials(other, [{ id: f.vm.id, status: 'stopped' }])
  assert.equal(missing.size, 0)
  const n = f.count()
  await collectLivePanelCredentials(f.project, [{ ...f.vm, status: 'stopped' }])
  assert.equal(f.count(), n)
  await collectLivePanelCredentials(f.project, [f.vm], { cacheMs: 0 })
  assert.equal(f.count(), n + 1)
})

test('invalidated background collection cannot publish stale data or mirror credentials', async (t) => {
  const f = await healthFixture(t)
  const file = path.join(f.project, 'vms', f.vm.id + '.json')
  const before = fs.readFileSync(file, 'utf8')
  await collectLivePanelCredentials(f.project, [f.vm], { background: true })
  await f.started
  const pending = collectLivePanelCredentials(f.project, [f.vm])
  invalidateLiveCredentialCache()
  f.finish()
  await pending
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  await collectLivePanelCredentials(f.project, [f.vm])
  assert.equal(f.count(), 2)
})

test('live credential prefers newer file TTL over stale worker snapshot', () => {
  const now = Date.now()
  const live = publicLiveCredential(
    {
      ok: true,
      credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: true,
        expires_at: now - 3600_000,
        credential_state: 'expired_refreshable',
      },
    },
    {
      has_access: true,
      has_refresh: true,
      expires_at: now + 8 * 3600_000,
    },
    now,
  )
  assert.equal(live.credential_state, 'fresh')
  assert.equal(live.needs_refresh, false)
  assert.ok(live.expires_at > now)
  assert.equal(live.source, 'slot-credentials')
})

test('fresh TTL drops leftover invalid_grant last_error', () => {
  const now = Date.now()
  const live = publicLiveCredential(
    {
      ok: true,
      last_error: 'OAuth refresh failed (invalid_grant): Refresh token not found or invalid',
      last_error_class: 'fatal',
      credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: false,
        expires_at: now + 8 * 3600_000,
      },
    },
    {
      has_access: true,
      has_refresh: true,
      expires_at: now + 8 * 3600_000,
    },
    now,
  )
  assert.equal(live.credential_state, 'fresh')
  assert.equal(live.last_error, null)
  assert.equal(live.last_error_class, null)
})

test('live credential keeps expired_refreshable when both TTLs are past', () => {
  const now = Date.now()
  const live = publicLiveCredential(
    null,
    {
      has_access: true,
      has_refresh: true,
      expires_at: now - 60_000,
    },
    now,
  )
  assert.equal(live.credential_state, 'expired_refreshable')
  assert.equal(live.needs_refresh, true)
  assert.equal(live.source, 'slot-credentials')
})

test('live collect reads slot credentials.json when vm.json TTL is stale', async () => {
  invalidateLiveCredentialCache()
  const project = tmpDir()
  const vms = path.join(project, 'vms')
  const home = path.join(vms, 'vm-06', 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  const freshMs = Date.now() + 7 * 3600_000
  fs.writeFileSync(
    path.join(vms, 'vm-06.json'),
    JSON.stringify({
      id: 'vm-06',
      name: '06',
      status: 'running',
      claude: {
        has_access: true,
        has_refresh: true,
        expires_at: Math.floor((Date.now() - 3600_000) / 1000),
        refreshed_at: '2026-08-20T00:00:00.000Z',
      },
      policy: { maxConcurrency: 4, weight: 1 },
    }),
  )
  fs.writeFileSync(
    path.join(home, 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        expiresAt: freshMs,
      },
    }),
  )
  const live = await collectLivePanelCredentials(
    project,
    [{ id: 'vm-06', expires_at: Math.floor((Date.now() - 3600_000) / 1000) }],
    { cacheMs: 0 },
  )
  const cred = live.get('vm-06')
  assert.ok(cred)
  assert.equal(cred.has_access, true)
  assert.ok(cred.expires_at >= freshMs - 1000)
  assert.equal(cred.credential_state, 'fresh')
  assert.ok(!JSON.stringify(cred).includes('test-access'))
  assert.ok(!JSON.stringify(cred).includes('test-refresh'))
  const mirrored = JSON.parse(fs.readFileSync(path.join(vms, 'vm-06.json'), 'utf8'))
  assert.ok(Number(mirrored.claude.expires_at) > Date.now() / 1000 - 10)
  assert.ok(!JSON.stringify(mirrored).includes('test-access'))
})
