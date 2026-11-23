import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { installRollingChild } from '../../src/lib/http/rolling-child.mjs'

function openStream(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ port, host: '127.0.0.1', path, agent: false }, (response) => {
      response.once('data', () => resolve(response))
      response.once('error', reject)
    })
    request.once('error', reject)
  })
}

test('rolling drain ends the panel status feed and waits for business streams and queued bills', async () => {
  const channel = new EventEmitter()
  const messages = []
  channel.send = (message) => messages.push(message)
  let queued = 1
  let retired = false
  const responses = new Map()
  const server = http.createServer((req, res) => rolling.request(serve, req, res))
  function serve(req, res) {
    responses.set(req.url, res)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(': started\n\n')
  }
  const rolling = installRollingChild(server, { channel, pendingWrites: () => queued, shutdown: () => { retired = true } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  try {
    const [panel, business] = await Promise.all([
      openStream(port, '/api/panel/pool/stream'),
      openStream(port, '/v1/responses'),
    ])
    const ended = once(panel, 'end')
    const finished = once(business, 'end')
    channel.emit('message', { type: 'drain', id: 'switch' })
    await ended
    assert.equal(business.complete, false)
    assert.equal(messages.length, 0)
    channel.emit('message', { type: 'retire', id: 'switch' })
    assert.deepEqual(messages, [{ type: 'busy', id: 'switch' }])
    responses.get('/v1/responses').end()
    await finished
    await delay(50)
    assert.equal(messages.length, 1)
    queued = 0
    for (let n = 0; n < 20 && messages.length === 1; n++) await delay(25)
    assert.deepEqual(messages.at(-1), { type: 'drained', id: 'switch' })
    channel.emit('message', { type: 'retire', id: 'switch' })
    assert.equal(retired, true)
  } finally {
    channel.emit('message', { type: 'resume', id: 'switch' })
    server.closeAllConnections()
    server.close()
  }
})
