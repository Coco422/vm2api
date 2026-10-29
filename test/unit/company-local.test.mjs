import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('one-command cleanup is idempotent and rejects foreign folders and symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(
    new URL('../../scripts/company-local.mjs', import.meta.url),
    path.join(root, 'scripts/company-local.mjs'),
  )
  const run = (cmd) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/company-local.mjs'), cmd], { encoding: 'utf8' })
  const sandbox = path.join(root, '.local/company-tests')
  assert.equal(run('status').status, 0)
  fs.writeFileSync(path.join(sandbox, 'data', 'fake.db'), 'owned data')
  const keep = path.join(root, 'keep.txt')
  fs.writeFileSync(keep, 'existing project data')
  assert.equal(run('cleanup').status, 0)
  assert.equal(fs.existsSync(sandbox), false)
  assert.equal(run('cleanup').status, 0)
  assert.equal(fs.readFileSync(keep, 'utf8'), 'existing project data')
  assert.equal(run('status').status, 0)
  const identity = spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8',
  }).stdout.trim()
  fs.writeFileSync(path.join(sandbox, 'server.json'), JSON.stringify({ pid: process.pid, identity }))
  assert.notEqual(run('cleanup').status, 0, 'must not stop an unrelated process even with its exact identity')
  assert.equal(fs.existsSync(path.join(sandbox, 'owner.json')), true)
  fs.rmSync(path.join(sandbox, 'server.json'))
  assert.equal(run('cleanup').status, 0)
  fs.mkdirSync(sandbox, { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'foreign.txt'), 'unowned')
  assert.notEqual(run('cleanup').status, 0)
  assert.equal(fs.existsSync(path.join(sandbox, 'foreign.txt')), true)
  fs.rmSync(sandbox, { recursive: true })
  const elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, sandbox)
  assert.notEqual(run('cleanup').status, 0)
  assert.equal(fs.existsSync(elsewhere), true)
})
