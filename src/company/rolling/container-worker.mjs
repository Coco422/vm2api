// This adapter runs beside the ingress. Controllers have no access to this
// process or its Docker client. A release refers to an immutable container ID.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import readline from 'node:readline'

const { containerId: id, context, port } = JSON.parse(process.env.VM2API_ROLLING_TARGET)
if (
  !/^[a-f0-9]{64}$/.test(id) ||
  !/^[a-zA-Z0-9_.-]+$/.test(context) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error('invalid container release')
const cli = ['--context', context]
const run = promisify(execFile)
async function docker(args) {
  return (await run('docker', [...cli, ...args], { timeout: 5000 })).stdout.trim()
}
const format =
  '{{json .State.Status}} {{json .HostConfig.RestartPolicy.Name}} {{json .Config.OpenStdin}} {{json .Config.Tty}} {{json (index .Config.Labels "vm2api.rolling")}}'
const meta = await docker(['inspect', '--format', format, id]).catch(() => {
  console.error('unable to establish controller ownership')
  process.exit(74)
})
if (!/^"(created|exited)" "(no|)" true false "managed"$/.test(meta)) {
  console.error('controller not stopped or not prepared for rolling')
  process.exit(74)
}
const session = randomUUID()
const attach = spawn('docker', [...cli, 'start', '-ai', id], { stdio: ['pipe', 'pipe', 'inherit'] })
const sockets = new Set()
let drain = null
let sent = false
let terminating = false
function control(msg) {
  if (!attach.stdin.destroyed) attach.stdin.write(JSON.stringify({ ...msg, session }) + '\n')
}
attach.stdin.on('error', () => {})
attach.on('error', () => process.exit(74))
control({ type: 'hello' })
function check() {
  if (drain && !sockets.size && !sent) {
    sent = true
    control({ type: 'drain', id: drain })
  }
}
process.on('message', (msg, socket) => {
  if (msg?.type === 'client' && socket) {
    const target = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    sockets.add(socket)
    socket.on('error', () => target.destroy())
    target.on('error', () => socket.destroy())
    socket.once('close', () => {
      target.destroy()
      sockets.delete(socket)
      check()
    })
    target.once('close', () => {
      if (!target.readableEnded) socket.destroy()
    })
    socket.pipe(target).pipe(socket)
  } else if (msg?.type === 'drain') {
    // Ask the controller to close idle keep-alives immediately. Its first
    // acknowledgement can precede our pending TCP connects; recheck after
    // they have closed before asking it to retire.
    drain = msg.id
    sent = false
    control(msg)
    check()
  } else if (msg?.type === 'resume' && drain === msg.id) {
    drain = null
    control(msg)
  } else if (msg?.type === 'retire' && drain === msg.id) {
    if (sockets.size) process.send({ type: 'busy', id: drain })
    else control(msg)
  }
})
let acknowledged = false
readline.createInterface({ input: attach.stdout }).on('line', async (line) => {
  const prefix = 'VM2API_ROLLING '
  if (!line.startsWith(prefix)) return
  let msg
  try {
    msg = JSON.parse(line.slice(prefix.length))
  } catch {
    return
  }
  if (msg.session !== session) return
  if (msg.type === 'ready') {
    try {
      if (msg.protocol !== 1) throw new Error('unsupported controller handoff protocol')
      const mode = await docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', id])
      if (mode === 'host') {
        if (msg.port !== port || msg.address !== '127.0.0.1') throw new Error('expected loopback listener')
      } else {
        const mappings = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', id]))
        const bindings = mappings?.[msg.port + '/tcp']
        if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || Number(bindings[0].HostPort) !== port)
          throw new Error('private port mapping mismatch')
      }
    } catch {
      await stop()
      return
    }
    acknowledged = true
    process.send({ type: 'ready', port })
  } else if (msg.type === 'drained' && msg.id === drain) {
    if (!sockets.size) process.send({ type: 'drained', id: drain })
    else {
      control({ type: 'resume', id: drain })
      sent = false
      check()
    }
  } else if (msg.type === 'busy') process.send(msg)
})
async function stop() {
  if (terminating) return
  terminating = true
  // A pre-admission candidate can be stopped gracefully even before ready.
  // Fence ambiguous state; never force-kill a controller to free the lease.
  try {
    await docker(['kill', '--signal', 'TERM', id])
  } catch {}
}
process.on('SIGTERM', stop)
process.on('disconnect', () => {
  if (!sockets.size) void stop()
  else
    for (const s of sockets)
      s.once('close', () => {
        if (!sockets.size) void stop()
      })
})
attach.on('close', async (code) => {
  try {
    const state = await docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', id])
    if (state === 'exited 0') process.exit(acknowledged && code === 0 ? 0 : 1)
    if (/^exited [0-9]+$/.test(state)) process.exit(1)
  } catch {}
  // The daemon is unreachable or its controller is still active. The parent
  // treats 74 as uncertain ownership and refuses to start a rollback.
  process.exit(74)
})
