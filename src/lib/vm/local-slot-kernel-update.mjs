import fs from 'node:fs/promises'
import { constants as F } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { kernelCpuCommand } from './kernel-cpu.mjs'
import { isValidVmId } from './vm-file.mjs'
import { toHostPath } from './host-path.mjs'
import { containerName } from './vm-runtime.mjs'
import { egressContainerName, networkName, slotNetworkForVm } from './egress.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import {
  describeCliNodePayload,
  describeKernelPayload,
  wrapCliTemplateDir,
  wrapKernelWrapperScript,
} from './wrap-cli-runtime.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'

const exec = promisify(execFile)
const docker = async (args) => (await exec('docker', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout
const entry = '/home/kincli/.kin/kin-kernel'
const fail = () => {
  throw new Error('slot_update_topology_unsupported')
}
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const fdPath = (dir, name) => path.join('/proc/self/fd', String(dir.fd), name)
async function withDir(root, parts, run) {
  let dir = await fs.open(root, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW)
  try {
    for (const component of parts) {
      const next = await fs.open(fdPath(dir, component), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW)
      await dir.close()
      dir = next
    }
    return await run(dir)
  } finally {
    await dir.close()
  }
}
async function regularAt(dir, name, run) {
  const file = await fs.open(fdPath(dir, name), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1) fail()
    return await run(file, stat)
  } finally {
    await file.close()
  }
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk)
  return hash.digest('hex')
}

export async function inspectLocalSlotKernel(project, vm, routing, run = docker) {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    !isValidVmId(vm.id) ||
    vm.node_id ||
    isCodexVm(vm) ||
    runtimeKind(vm) !== 'docker' ||
    resolveKernelDataplane(vm, routing) !== 'wrap' ||
    !vm.proxy?.id
  )
    fail()
  const inspect = async (type, name) => JSON.parse(await run(['inspect', '--type', type, name]))[0]
  const name = containerName(vm.id)
  const network = networkName(vm.proxy.id)
  if (!network || network !== slotNetworkForVm(vm)) fail()
  const [slot, net, helper] = await Promise.all([
    inspect('container', name),
    inspect('network', network),
    inspect('container', egressContainerName(vm.proxy.id)),
  ])
  const hostDir = toHostPath(path.join(project, 'vms', vm.id), { projectRoot: project })
  const argv = [entry, '--gateway-worker', '--config', '/run/kin/kernel.json']
  const actual = [slot.Path, ...slot.Args]
  const endpoint = slot.NetworkSettings?.Networks?.[network]
  const binds = (dst, src) =>
    slot.Mounts?.some((m) => m.Type === 'bind' && m.Destination === dst && m.Source === path.join(hostDir, src))
  const running =
    vm.status === 'running' ||
    (vm.status === 'paused' && vm.schedule_off === true && vm.schedule_off_reason === 'tenant_paused')
  if (
    !running ||
    !/^[0-9a-f]{64}$/.test(slot.Id) ||
    slot.Config.Labels?.['kin.vm.id'] !== vm.id ||
    slot.State.Status !== 'running' ||
    !slot.State.Running ||
    slot.State.Paused !== false ||
    (!isDeepStrictEqual(actual, argv) && !isDeepStrictEqual(actual, kernelCpuCommand(argv))) ||
    !binds('/home/kincli', 'cli-home') ||
    !binds('/run/kin', 'run') ||
    slot.Mounts.some(
      (m) =>
        m.Destination === '/home/kincli/.kin' ||
        m.Destination.startsWith('/home/kincli/.kin/') ||
        m.Destination === '/run/kin/kernel.json',
    ) ||
    net.Driver !== 'bridge' ||
    net.Name !== network ||
    Object.keys(net.Containers || {}).length !== 1 ||
    !net.Containers[slot.Id] ||
    slot.HostConfig.NetworkMode !== network ||
    Object.keys(slot.NetworkSettings.Networks).length !== 1 ||
    !endpoint?.IPAddress ||
    endpoint.NetworkID !== net.Id ||
    net.Containers[slot.Id].IPv4Address?.split('/')[0] !== endpoint.IPAddress ||
    helper.Config.Labels?.['kin.egress.proxy'] !== vm.proxy.id ||
    helper.Config.Labels?.['kin.egress.local'] !== '1' ||
    helper.HostConfig.NetworkMode !== 'host' ||
    !helper.State.Running ||
    helper.State.Status !== 'running' ||
    helper.State.Paused !== false
  )
    fail()
  const bytes = await withDir(path.join(project, 'vms'), [vm.id, 'run'], (dir) =>
    regularAt(dir, 'kernel.json', (file) => file.readFile()),
  )
  const config = JSON.parse(bytes)
  if (
    config.vm_id !== vm.id ||
    config.dataplane !== 'wrap' ||
    config.claude_bin !== '/home/kincli/.kin/cli-node' ||
    !Number.isInteger(config.slots_per_worker) ||
    config.slots_per_worker < 1
  )
    fail()
  const payloadDir = await withDir(path.join(project, 'vms'), [vm.id, 'cli-home', '.kin'], (dir) =>
    dir.stat({ bigint: true }),
  )
  return {
    id: slot.Id,
    payloadDirDevice: String(payloadDir.dev),
    payloadDirInode: String(payloadDir.ino),
    running: true,
    slots: config.slots_per_worker,
    configSha: sha(bytes),
    ip: endpoint.IPAddress,
    network: net.Id,
    memory: slot.HostConfig.Memory,
    swap: slot.HostConfig.MemorySwap,
    nanoCpus: slot.HostConfig.NanoCpus,
    helper: helper.Id,
    helperStarted: helper.State.StartedAt,
  }
}

export async function publishLocalSlotKernel(vm, project, onReplace = () => {}) {
  if (!isValidVmId(vm.id)) fail()
  const template = wrapCliTemplateDir(project)
  const dirArgs = [path.join(project, 'vms'), [vm.id, 'cli-home', '.kin']]
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'deploy/payload.json'), 'utf8'))
  const pins = new Map(manifest.files.map((file) => [file.path, file.sha256]))
  return withDir(...dirArgs, async (dir) => {
    const pinned = await dir.stat({ bigint: true })
    const assertCurrentDirectory = () =>
      withDir(...dirArgs, async (current) => {
        const actual = await current.stat({ bigint: true })
        if (actual.dev !== pinned.dev || actual.ino !== pinned.ino) throw new Error('slot_update_topology_changed')
      })
    const wrapper = await regularAt(dir, 'kin-kernel', (file) => file.readFile('utf8'))
    if (
      wrapper !== wrapKernelWrapperScript() ||
      wrapper !== (await fs.readFile(path.join(template, 'kin-kernel'), 'utf8'))
    )
      fail()
    const glibc = 'glibc239'
    const srcLib = path.join(template, glibc)
    const source = await fs.readdir(srcLib, { withFileTypes: true })
    const names = source
      .filter((x) => x.isFile())
      .map((x) => x.name)
      .sort()
    if (
      !names.includes('ld-linux-x86-64.so.2') ||
      source.some((x) => !x.isFile() && !(x.name === 'arm64' && x.isDirectory()))
    )
      fail()
    await withDir(fdPath(dir, glibc), [], async (lib) => {
      const targets = await fs.readdir(fdPath(lib, '.'), { withFileTypes: true })
      if (
        targets.some((x) => !x.isFile() && !(x.name === 'arm64' && x.isDirectory())) ||
        !isDeepStrictEqual(
          names,
          targets
            .filter((x) => x.isFile())
            .map((x) => x.name)
            .sort(),
        )
      )
        fail()
      for (const name of names)
        if (sha(await fs.readFile(path.join(srcLib, name))) !== (await regularAt(lib, name, hashFile))) fail()
    })
    const targets = [
      ['cli-node', describeCliNodePayload(project).path],
      ['kin-kernel.bin', describeKernelPayload(project).path],
    ]
    const staged = []
    try {
      for (const [name, src] of targets) {
        const data = await fs.readFile(src)
        const expected = pins.get('share/wrap-cli/' + name)
        if (sha(data) !== expected) throw new Error('slot_payload_digest_mismatch')
        const result = await regularAt(dir, name, async (file, stat) => ({
          stat,
          identical: (await hashFile(file)) === expected,
        }))
        if ((result.stat.mode & 0o7000) !== 0 || !(result.stat.mode & 0o111)) fail()
        if (result.identical) continue
        const tmp = fdPath(dir, '.release-' + crypto.randomUUID())
        const h = await fs.open(tmp, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600)
        staged.push({ tmp, name, expected })
        try {
          await h.writeFile(data)
          await h.chown(result.stat.uid, result.stat.gid)
          await h.chmod(result.stat.mode & 0o777)
          await h.sync()
        } finally {
          await h.close()
        }
      }
      await assertCurrentDirectory()
      for (const f of staged) {
        onReplace()
        await fs.rename(f.tmp, fdPath(dir, f.name))
        if ((await regularAt(dir, f.name, hashFile)) !== f.expected) fail()
      }
      await assertCurrentDirectory()
      await dir.sync()
      return { ok: true, wrap: { pushed: staged.length > 0 } }
    } finally {
      for (const f of staged)
        await fs.unlink(f.tmp).catch((e) => {
          if (e.code !== 'ENOENT') throw e
        })
    }
  })
}

export async function restartLocalSlotKernel(exec, before, { run = docker, health = rustKernelHealth } = {}) {
  await run(['restart', before.id])
  const deadline = Date.now() + 30000
  do {
    const seen = await health(exec, { timeoutMs: 1000 })
    if (seen?.ok && seen.healthy !== false && seen.recovering !== true && seen.ready_slots > 0) return { ok: true }
    await delay(250)
  } while (Date.now() < deadline)
  return { ok: false }
}
