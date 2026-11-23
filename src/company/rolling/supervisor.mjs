import net from 'node:net'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

function within(promise, ms, reason) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function unavailable(socket) {
  socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n')
  socket.destroySoon()
}

// Only pass a client fd once. Replaying an ambiguous POST could charge it twice.
export function createRollingSupervisor({ releases, env, verify, drainMs, startMs, waitMs, queueLimit }) {
  for (const n of [drainMs, startMs, waitMs, queueLimit])
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new Error('invalid rolling limit')
  if (drainMs >= waitMs || typeof verify !== 'function') throw new Error('readiness and spare wait budget required')
  const queue = new Map()
  let state = 'offline'
  let active = null
  let soleChild = null
  let transaction = null
  let stopping = false

  function deliver(worker, socket) {
    if (socket.destroyed) return
    if (!worker?.child.connected) return unavailable(socket)
    worker.child.send({ type: 'client' }, socket, (err) => {
      if (err) socket.destroy()
    })
  }
  function serve(worker) {
    active = worker
    state = 'serving'
    for (const [socket, item] of queue) {
      clearTimeout(item.timer)
      queue.delete(socket)
      if (performance.now() >= item.deadline) unavailable(socket)
      else deliver(worker, socket)
    }
  }
  function rejectQueue() {
    for (const [socket, item] of queue) {
      clearTimeout(item.timer)
      queue.delete(socket)
      unavailable(socket)
    }
  }
  const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
    socket.on('error', () => socket.destroy())
    if (state === 'serving') return deliver(active, socket)
    if (state === 'offline' || stopping) return unavailable(socket)
    if (queue.size >= queueLimit) {
      if (state === 'draining') {
        transaction.cancel()
        return deliver(active, socket)
      }
      return unavailable(socket)
    }
    const timer = setTimeout(() => {
      queue.delete(socket)
      unavailable(socket)
    }, waitMs)
    queue.set(socket, { timer, deadline: performance.now() + waitMs })
    socket.once('close', () => {
      clearTimeout(timer)
      queue.delete(socket)
    })
  })
  async function boot(name, readinessMs = startMs) {
    if (!Object.hasOwn(releases, name) || soleChild) throw new Error('invalid release or controller still running')
    const target = releases[name]
    const container = typeof target === 'object'
    const entry = container ? new URL('./container-worker.mjs', import.meta.url) : target
    const child = fork(entry, [], {
      env: {
        ...(container
          ? { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG }
          : env),
        VM2API_ROLLING_CHILD: '1',
        ...(container ? { VM2API_ROLLING_TARGET: JSON.stringify(target) } : {}),
      },
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const worker = { child, name }
    soleChild = worker
    worker.exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        if (soleChild === worker && !(container && (code === 74 || signal))) soleChild = null
        if (active === worker && state === 'serving') {
          state = 'offline'
          active = null
        }
        resolve({ code, signal })
      })
    })
    const earlyExit = worker.exited.then(() => {
      throw new Error('controller exited')
    })
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.on('message', (msg) => {
        if (msg?.type === 'ready') resolve(msg.port)
        if (msg?.type === 'busy' && transaction?.id === msg.id && transaction.worker === worker) transaction.busy()
        if (msg?.type === 'drained' && transaction?.id === msg.id && transaction.worker === worker)
          transaction.drained()
      })
    })
    const abort = new AbortController()
    try {
      await within(
        Promise.race([earlyExit, ready.then((port) => verify({ name, port, signal: abort.signal }))]),
        readinessMs,
        'controller readiness timed out',
      )
      if (soleChild !== worker || !child.connected) throw new Error('controller unavailable after verification')
      return worker
    } catch (err) {
      abort.abort()
      // This candidate has never received public connections. Wait for its exit
      // before permitting a rollback process to open the shared state.
      if (child.exitCode == null && !child.signalCode) child.kill('SIGTERM')
      await within(worker.exited, startMs, 'unready controller retained ownership')
      throw err
    } finally {
      abort.abort()
    }
  }
  async function change(name) {
    if (transaction || stopping || state !== 'serving') throw new Error('release busy or offline')
    if (!Object.hasOwn(releases, name)) throw new Error('unknown release')
    if (name === active.name) return 'already-serving'
    const old = active
    const id = randomUUID()
    let settle
    let stillBusy
    const busy = new Promise((resolve) => {
      stillBusy = () => resolve('busy')
    })
    const started = performance.now()
    const cutoff = started + drainMs
    const drained = new Promise((resolve) => {
      settle = resolve
    })
    let finish
    const finished = new Promise((resolve) => {
      finish = resolve
    })
    transaction = {
      finished,
      id,
      worker: old,
      busy: stillBusy,
      drained: () => settle(true),
      cancel() {
        if (state !== 'draining') return
        if (old.child.connected) old.child.send({ type: 'resume', id })
        if (old.child.connected) serve(old)
        else {
          state = 'offline'
          rejectQueue()
        }
        settle(false)
      },
    }
    state = 'draining'
    const timer = setTimeout(() => transaction?.cancel(), drainMs)
    try {
      old.child.send({ type: 'drain', id })
      if (!(await drained) || state !== 'draining') return 'deferred'
      if (performance.now() >= cutoff) {
        transaction.cancel()
        return 'deferred'
      }
      state = 'retiring'
      old.child.send({ type: 'retire', id })
      const exit = await within(Promise.race([old.exited, busy]), startMs, 'old controller still owns shared state')
      if (exit === 'busy') {
        state = 'draining'
        transaction.cancel()
        return 'deferred'
      }
      if (exit.code !== 0) throw new Error('unclean controller exit')
      active = null
      state = 'starting'
      try {
        // Give recovery the second half of the remaining client wait budget.
        const remaining = started + waitMs - performance.now()
        if (remaining <= 0) throw new Error('candidate budget exhausted')
        serve(await boot(name, Math.min(startMs, Math.max(1, Math.floor(remaining / 2)))))
        return 'switched'
      } catch (err) {
        if (soleChild) throw err
        state = 'restoring'
        serve(await boot(old.name))
        return 'rolled-back'
      }
    } catch (err) {
      state = 'offline'
      rejectQueue()
      throw err
    } finally {
      clearTimeout(timer)
      transaction = null
      finish()
    }
  }
  return {
    server,
    change,
    status: () => ({ state, release: active?.name ?? null, queued: queue.size, pid: soleChild?.child.pid ?? null }),
    async start(name) {
      if (state !== 'offline' || transaction || stopping) throw new Error('not idle')
      state = 'starting'
      try {
        serve(await boot(name))
      } catch (err) {
        state = 'offline'
        rejectQueue()
        throw err
      }
    },
    async stop() {
      stopping = true
      if (transaction) await transaction.finished
      state = 'offline'
      rejectQueue()
      if (server.listening) server.close()
      if (soleChild) {
        const worker = soleChild
        // Treat an operator shutdown like loss of the ingress channel. The
        // worker owns its existing sockets until they close naturally.
        if (worker.child.connected) worker.child.disconnect()
        await worker.exited
      }
    },
  }
}
