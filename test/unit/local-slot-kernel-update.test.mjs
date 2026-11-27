import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { renameSync, mkdirSync } from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLocalSlotKernel, restartLocalSlotKernel } from '../../src/lib/vm/local-slot-kernel-update.mjs'
import { wrapKernelWrapperScript } from '../../src/lib/vm/wrap-cli-runtime.mjs'

test('local pinned directory publication preserves uid/gid/mode, socket config and surrounding identity', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slot-unit-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const id = 'vm-release-fixture',
    src = path.join(root, 'share/wrap-cli'),
    home = path.join(root, 'vms', id, 'cli-home'),
    dst = path.join(home, '.kin')
  for (const dir of [src, dst]) {
    await fs.mkdir(path.join(dir, 'glibc239'), { recursive: true })
    await fs.writeFile(path.join(dir, 'glibc239/ld-linux-x86-64.so.2'), 'loader')
    await fs.writeFile(path.join(dir, 'kin-kernel'), wrapKernelWrapperScript())
    for (const n of ['cli-node', 'kin-kernel.bin'])
      await fs.writeFile(path.join(dir, n), dir === src ? 'new-' + n : 'old-' + n, { mode: 0o751 })
  }
  const repin = async () => {
    await fs.mkdir(path.join(root, 'deploy'), { recursive: true })
    const files = await Promise.all(
      ['cli-node', 'kin-kernel.bin'].map(async (name) => ({
        path: 'share/wrap-cli/' + name,
        sha256: crypto
          .createHash('sha256')
          .update(await fs.readFile(path.join(src, name)))
          .digest('hex'),
      })),
    )
    await fs.writeFile(path.join(root, 'deploy/payload.json'), JSON.stringify({ files }))
  }
  await repin()
  const sentinel = path.join(home, 'identity')
  await fs.writeFile(sentinel, 'keep')
  const vm = { id }
  const publish = () => publishLocalSlotKernel(vm, root)
  const stat = await fs.stat(path.join(dst, 'cli-node'))
  assert.equal((await publish()).wrap.pushed, true)
  assert.equal((await publish()).wrap.pushed, false)
  const after = await fs.stat(path.join(dst, 'cli-node'))
  assert.deepEqual([after.mode, after.uid, after.gid], [stat.mode, stat.uid, stat.gid])
  assert.equal(await fs.readFile(path.join(dst, 'kin-kernel.bin'), 'utf8'), 'new-kin-kernel.bin')
  await fs.writeFile(path.join(src, 'cli-node'), 'next')
  await assert.rejects(publish, /slot_payload_digest_mismatch/)
  await repin()
  await fs.writeFile(path.join(dst, 'glibc239/ld-linux-x86-64.so.2'), 'mismatch')
  await assert.rejects(publish)
  assert.equal(await fs.readFile(path.join(dst, 'cli-node'), 'utf8'), 'new-cli-node')
  await fs.writeFile(path.join(dst, 'glibc239/ld-linux-x86-64.so.2'), 'loader')
  await fs.unlink(path.join(dst, 'kin-kernel.bin'))
  await fs.symlink(sentinel, path.join(dst, 'kin-kernel.bin'))
  await assert.rejects(publish)
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep')
  assert.equal(await fs.readFile(path.join(dst, 'cli-node'), 'utf8'), 'new-cli-node')
  await fs.unlink(path.join(dst, 'kin-kernel.bin'))
  await fs.writeFile(path.join(dst, 'kin-kernel.bin'), 'new-kin-kernel.bin', { mode: 0o751 })
  await assert.rejects(
    publishLocalSlotKernel(vm, root, () => {
      renameSync(dst, dst + '-moved')
      mkdirSync(dst)
    }),
    /slot_update_topology_changed/,
  )
  await fs.rmdir(dst)
  await fs.rename(dst + '-moved', dst)
  await fs.rename(dst, dst + '-old')
  await fs.symlink(dst + '-old', dst)
  await assert.rejects(publish)
})
test('local restart only sends immutable container ID and waits for ready health', async () => {
  const calls = []
  const id = '1'.repeat(64)
  let polls = 0
  const result = await restartLocalSlotKernel(
    { vmId: 'fixture' },
    { id },
    {
      run: async (args) => calls.push(args),
      health: async () => (++polls === 1 ? { ok: false } : { ok: true, healthy: true, ready_slots: 1 }),
    },
  )
  assert.equal(result.ok, true)
  assert.equal(polls, 2)
  assert.deepEqual(calls, [['restart', id]])
})
