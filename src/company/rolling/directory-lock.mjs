import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function lock(fd) {
  const result = spawnSync('flock', ['-n', '-E', '75', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
    encoding: 'utf8',
  })
  if (result.status === 75) throw new Error('vm2api_control_plane_already_running: stop the other controller first')
  if (result.status !== 0) {
    throw new Error(`vm2api_control_plane_lock_failed: ${result.error?.message || result.stderr?.trim() || result.signal}`)
  }
}

// These descriptors intentionally stay open until the owning controller exits.
// The project directory protects shared egress state. A separate database volume
// also needs a lock so different project paths cannot open the same database.
export function acquireControllerDirectories(projectDataDir, databaseDir, inherited) {
  const open = (dir) => fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  const stat = (dir) => fs.statSync(dir, { bigint: true })
  fs.mkdirSync(projectDataDir, { recursive: true })
  const project = stat(projectDataDir)
  const fd = inherited === undefined ? open(projectDataDir) : Number(inherited)
  let dbFd
  try {
    if (!sameDirectory(fs.fstatSync(fd, { bigint: true }), project)) {
      throw new Error('vm2api_control_plane_lock_failed: bootstrap fd does not identify project data')
    }
    lock(fd)
    fs.mkdirSync(databaseDir, { recursive: true })
    if (!sameDirectory(stat(databaseDir), project)) {
      dbFd = open(databaseDir)
      lock(dbFd)
    }
  } catch (error) {
    if (dbFd !== undefined) fs.closeSync(dbFd)
    if (inherited === undefined) fs.closeSync(fd)
    throw error
  }
}
