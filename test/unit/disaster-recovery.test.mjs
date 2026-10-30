import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('disaster recovery checks hashes, safe extraction, seven-day rotation and online WAL snapshots', () => {
  const result = spawnSync('python3', ['test/unit/disaster-recovery.test.py'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
