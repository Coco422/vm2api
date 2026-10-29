/** Explicit operator tool; no default database path, no network, no schema migrations. */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { reviewCompanyOpenaiReset } from '../src/company/quota-reset-receipt.mjs'

const args = process.argv.slice(2)
const value = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
const file = value('--db')
const vmId = value('--vm')
const confirm = args.includes('--confirm-upstream-reviewed')
if (!file || !fs.existsSync(file) || !vmId || !/^[a-zA-Z0-9_-]{1,128}$/.test(vmId))
  throw new Error('Usage: --db <existing DB> --vm <VM id> [--confirm-upstream-reviewed --at <status.at>]')
const db = new DatabaseSync(file, { readOnly: !confirm })
try {
  console.log(
    JSON.stringify(reviewCompanyOpenaiReset({ db, vmId, expectedAt: confirm ? Number(value('--at')) : null, confirm })),
  )
} finally {
  db.close()
}
