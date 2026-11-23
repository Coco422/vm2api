/** Single-connection, transactional write batches. Keep failed work in order until committed.
 * Callbacks must contain replay-safe database writes; this is an in-memory queue,
 * not protection against SIGKILL, power loss or a destroyed database.
 */
const BATCH = 32
const RETRY_MS = 1000
const queue = []
let scheduled = null
let db = null
let rollbackFailed = false

export function armWriteBehind(database) {
  const next = database || null
  if (next !== db && queue.length) throw pendingError()
  db = next
  if (!db) cancelScheduled()
}

export function writeBehindArmed() {
  return !!db
}

export function enqueueWrite(fn) {
  if (!db) throw new Error('write-behind database is not armed')
  queue.push(fn)
  schedule()
}

function cancelScheduled() {
  if (scheduled) {
    clearImmediate(scheduled)
    clearTimeout(scheduled)
    scheduled = null
  }
}

function pendingError(cause) {
  const err = new Error(`write-behind has ${queue.length} uncommitted write(s)`, { cause })
  err.code = 'WRITE_BEHIND_PENDING'
  return err
}

export function flushWrites() {
  cancelScheduled()
  while (queue.length) {
    const failure = drainBatch()
    if (failure) {
      schedule(true)
      throw pendingError(failure)
    }
  }
}

export function pendingWrites() {
  return queue.length
}

function schedule(retry = false) {
  if (scheduled || !queue.length || !db) return
  const run = () => {
    scheduled = null
    const failure = drainBatch()
    if (failure) console.warn('[write-behind] batch retained; retrying:', failure.message)
    schedule(!!failure)
  }
  scheduled = retry ? setTimeout(run, RETRY_MS) : setImmediate(run)
  scheduled.unref?.()
}

function drainBatch() {
  if (!queue.length) return null
  if (!db) return new Error('database is not armed')
  if (rollbackFailed) return new Error('rollback failed; database connection requires recovery')
  // Do not remove work until COMMIT succeeds. Failed callbacks roll the entire batch back.
  const batch = queue.slice(0, BATCH)
  let began = false
  try {
    db.exec('BEGIN IMMEDIATE')
    began = true
    for (const fn of batch) fn()
    db.exec('COMMIT')
    queue.splice(0, batch.length)
    return null
  } catch (err) {
    if (began) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // An uncertain transaction must never be replayed or declared flushed.
        rollbackFailed = true
      }
    }
    return err
  }
}
