import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'

const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-request-auth-'))
const priorDataDir = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = sessionDir
const { createRequestAuth } = await import('../../src/lib/core/request-auth.mjs')
const { createPanelSession, revokePanelSession } = await import('../../src/lib/core/security.mjs')
after(() => {
  if (priorDataDir == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = priorDataDir
  fs.rmSync(sessionDir, { recursive: true, force: true })
})

function fixture(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiKeyStore({ db, hashSecret: 'local-auth-test' })
  const now = new Date().toISOString()
  store.users.insert({
    id: 'tenant',
    username: 'tenant',
    role: 'user',
    password_hash: 'fixture',
    concurrency: 12,
    created_at: now,
    updated_at: now,
  })
  const key = store.create({ name: 'tenant', user_id: 'tenant', max_concurrency: 2, quota_requests: 2, rpm: 0 })
  const session = createPanelSession('tenant', { role: 'user' })
  t.after(() => revokePanelSession(session))
  const json = (res, status, body) => {
    res.status = status
    res.body = body
    return body
  }
  const auth = createRequestAuth({
    cfg: { api_key: 'test-master' },
    apiKeyStore: store,
    panelUsers: { getByUsername: () => ({ id: 'tenant', role: 'user', vm_create_quota: 0 }) },
    allowRate: () => true,
    json,
  })
  return { store, key, session, json, ...auth }
}

test('panel session still reads the console but every protocol credential form rejects it', (t) => {
  const f = fixture(t)
  for (const headers of [
    { cookie: `kin_panel_token=${f.session}` },
    { authorization: `Bearer ${f.session}` },
    { 'x-panel-token': f.session },
    { 'x-api-key': f.session },
  ]) {
    const req = { headers },
      res = {}
    assert.equal(f.requireProtocolAuth(req, res), false)
    assert.equal(res.status, 401)
    assert.equal(req.apiKeyRecord, undefined)
  }
  const req = { headers: { cookie: `kin_panel_token=${f.session}` } }
  assert.equal(f.requireAuth(req, {}), true)
  assert.equal(req.panelRole, 'user')
  assert.equal(req.panelUserId, 'tenant')
})

test('API key wins over a panel Cookie and invalid/disabled/expired/exhausted keys cannot fall back to it', (t) => {
  const f = fixture(t)
  for (const credential of [{ authorization: `Bearer ${f.key.key}` }, { 'x-api-key': f.key.key }]) {
    const req = { headers: { cookie: `kin_panel_token=${f.session}`, ...credential } }
    assert.equal(f.requireProtocolAuth(req, {}), true)
    assert.equal(req.apiKeyKind, 'managed')
    assert.equal(req.apiKeyRecord.id, f.key.id)
    assert.equal(req.panelUser, undefined)
  }
  const run = (token = f.key.key) => {
    const res = {}
    const ok = f.requireProtocolAuth(
      { headers: { authorization: `Bearer ${token}`, cookie: `kin_panel_token=${f.session}` } },
      res,
    )
    return { ok, res }
  }
  assert.equal(run('invalid').res.status, 401)
  f.store.update(f.key.id, { status: 'disabled' })
  assert.equal(run().ok, false)
  f.store.update(f.key.id, { status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal(run().res.body.error.code, 'api_key_expired')
  f.store.update(f.key.id, { expires_at: null })
  f.store.recordUsage(f.store.getById(f.key.id), {})
  f.store.recordUsage(f.store.getById(f.key.id), {})
  assert.equal(run().res.body.error.code, 'api_key_quota_exhausted')
})

test('Cookie does not bypass key concurrency, user concurrency or RPM and master inference remains valid', (t) => {
  const f = fixture(t)
  const run = () => {
    const res = {}
    const ok = f.requireProtocolAuth(
      { headers: { 'x-api-key': f.key.key, cookie: `kin_panel_token=${f.session}` } },
      res,
    )
    return { ok, res }
  }
  assert.equal(f.store.acquire(f.store.getById(f.key.id)).ok, true)
  assert.equal(f.store.acquire(f.store.getById(f.key.id)).ok, true)
  assert.equal(run().res.body.error.code, 'api_key_concurrency_limit')
  f.store.release(f.key.id)
  f.store.release(f.key.id)
  const owner = f.store.users.getById('tenant')
  f.store.users.update({ ...owner, concurrency: 1 })
  assert.equal(f.store.acquire(f.store.getById(f.key.id)).ok, true)
  assert.equal(run().res.body.error.code, 'user_concurrency_limit')
  f.store.release(f.key.id)
  f.store.users.update({ ...owner, concurrency: 12 })
  f.store.rpmBuckets.clear()
  f.store.update(f.key.id, { rpm: 1 })
  assert.equal(f.store.acquire(f.store.getById(f.key.id)).ok, true)
  f.store.release(f.key.id)
  assert.equal(run().res.status, 429)
  const req = { headers: { authorization: 'Bearer test-master', cookie: `kin_panel_token=${f.session}` } }
  assert.equal(f.requireProtocolAuth(req, {}), true)
  assert.equal(req.apiKeyKind, 'master')
})

test('all HTTP inference handlers reject panel sessions before reading input or scheduling upstream work', async (t) => {
  const f = fixture(t)
  let reads = 0
  const handlers = createHandleProtocol({
    requireAuth: f.requireProtocolAuth,
    json: f.json,
    readBody: async () => {
      reads++
      throw Error('must not read')
    },
    requestLog: { start: () => ({ request_id: 'fixture' }), finish() {} },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.completions', 'openai.responses']) {
    const res = { on() {}, once() {} }
    await handlers.handleProtocol(
      { headers: { cookie: `kin_panel_token=${f.session}` }, method: 'POST' },
      res,
      protocol,
      '/fixture',
    )
    assert.equal(res.status, 401)
  }
  for (const kind of ['search', 'images']) {
    const res = { on() {}, once() {} },
      req = { headers: { cookie: `kin_panel_token=${f.session}` }, method: 'POST' }
    if (kind === 'search') await handlers.handleSearch(req, res, '/v1/alpha/search')
    else await handlers.handleImages(req, res, '/v1/images/generations', 'generations')
    assert.equal(res.status, 401)
  }
  assert.equal(reads, 0)
})

test('Responses WebSocket rejects a panel Cookie during handshake without invoking inference', async (t) => {
  const f = fixture(t)
  let calls = 0
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const auth = createRequestAuth({
    cfg: { api_key: 'test-master' },
    apiKeyStore: f.store,
    panelUsers: {},
    allowRate: () => true,
    json,
  })
  const handler = createResponsesWsHandler({
    requireAuth: auth.requireProtocolAuth,
    json,
    handleProtocol: () => {
      calls++
    },
    getRouting: () => ({ websocket: { enabled: true }, codex: { websocket: { enabled: true } } }),
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => handler.handleUpgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`, {
      headers: { cookie: `kin_panel_token=${f.session}` },
    })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    ws.on('open', () => {
      ws.terminate()
      reject(Error('session handshake accepted'))
    })
    ws.on('error', () => {})
  })
  assert.equal(status, 401)
  assert.equal(calls, 0)
})
