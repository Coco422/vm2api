// Local release supervisor. Its control listener uses an operator-owned private directory.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { createRollingSupervisor } from '../src/company/rolling/supervisor.mjs'

const [action, target, release] = process.argv.slice(2)
if (action === 'serve') {
  const conf = JSON.parse(fs.readFileSync(target, 'utf8'))
  const { socket, host, port, releases, project, verifyModule } = conf
  for (const file of [socket, project, verifyModule, ...Object.values(releases).filter((r) => typeof r === 'string')])
    if (!path.isAbsolute(file)) throw new Error('absolute configuration paths required')
  const dir = fs.lstatSync(path.dirname(socket))
  if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & 0o077)
    throw new Error('control directory must be private')
  if (!Object.hasOwn(releases, release)) throw new Error('explicit initial release required')
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('explicit public listen address required')
  if (process.env.VM2API_BOOTSTRAP_LOCK_FD) throw new Error('supervisor must start outside the controller lock')
  const { verify, preflight } = await import(pathToFileURL(verifyModule))
  if (typeof preflight !== 'function') throw new Error('release preflight hook required')
  const receipt = socket + '.release.json'
  function saveReceipt(record) {
    const temporary = receipt + '.' + process.pid + '.new'
    fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flush: true })
    fs.renameSync(temporary, receipt)
    const fd = fs.openSync(path.dirname(receipt), 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
  function selected(name) {
    return { state: 'selected', name, target: releases[name] }
  }
  let preparing = false
  async function change(name) {
    if (preparing || app.status().state !== 'serving') throw new Error('release busy or offline')
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new Error('invalid release')
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (!Object.hasOwn(manifest.releases, name)) throw new Error('release missing in manifest')
    const next = manifest.releases[name]
    if (typeof next === 'string' && !path.isAbsolute(next)) throw new Error('absolute release path required')
    if (Object.hasOwn(releases, name) && JSON.stringify(releases[name]) !== JSON.stringify(next))
      throw new Error('release name already pinned to a different target')
    preparing = true
    try {
      const current = app.status().release
      if (name === current) return 'already-serving'
      await preflight({ current, name, previous: releases[current], candidate: next, project })
      Object.defineProperty(releases, name, { value: next, configurable: true, enumerable: true })
      saveReceipt({ state: 'changing', previous: selected(current), candidate: selected(name) })
      const result = await app.change(name)
      if (app.status().state !== 'serving') throw new Error('controller unavailable after change')
      saveReceipt(selected(app.status().release))
      return result
    } finally {
      preparing = false
    }
  }
  const app = createRollingSupervisor({
    ...conf,
    verify,
    env: {
      ...process.env,
      KIN_PROJECT_ROOT: project,
      KIN_DATA_DIR: process.env.KIN_DATA_DIR || path.join(project, 'data'),
      KIN_CAPTURES_DIR: process.env.KIN_CAPTURES_DIR || path.join(project, 'captures'),
      KIN_ROUTING_FILE: process.env.KIN_ROUTING_FILE || path.join(project, 'config/routing.json'),
    },
  })
  const control = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    res.setHeader('Content-Type', 'application/json')
    try {
      if (req.method === 'GET' && url.pathname === '/status') res.end(JSON.stringify(app.status()))
      else if (req.method === 'POST' && url.pathname === '/change') {
        res.end(JSON.stringify({ result: await change(url.searchParams.get('release')), ...app.status() }))
      } else res.writeHead(404).end()
    } catch (e) {
      res.writeHead(409).end(JSON.stringify({ error: e.message, ...app.status() }))
    }
  })
  try {
    control.listen(socket)
    await once(control, 'listening')
    fs.chmodSync(socket, 0o600)
    let initial = release
    if (fs.existsSync(receipt)) {
      const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'))
      if (
        saved.state !== 'selected' ||
        !Object.hasOwn(releases, saved.name) ||
        JSON.stringify(releases[saved.name]) !== JSON.stringify(saved.target)
      )
        throw new Error('reconcile interrupted release or target mismatch before restarting')
      initial = saved.name
    }
    await app.start(initial)
    saveReceipt(selected(initial))
    app.server.listen(port, host)
    await once(app.server, 'listening')
    console.log(JSON.stringify(app.status()))
  } catch (err) {
    control.close()
    await app.stop()
    throw err
  }
  async function stop() {
    control.close()
    await app.stop()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
} else if (action === 'status' || action === 'change') {
  if (action === 'change' && !release) throw new Error('release required')
  const req = http.request(
    {
      socketPath: target,
      method: action === 'change' ? 'POST' : 'GET',
      path: action === 'change' ? '/change?release=' + encodeURIComponent(release) : '/status',
    },
    (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        console.log(body)
        if (
          res.statusCode !== 200 ||
          (action === 'change' && !['switched', 'already-serving'].includes(JSON.parse(body).result))
        )
          process.exitCode = 1
      })
    },
  )
  req.on('error', (err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  req.end()
} else throw new Error('usage: serve CONFIG INITIAL | status SOCKET | change SOCKET RELEASE')
