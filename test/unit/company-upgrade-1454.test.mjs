import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { tenantTestKey } from '../../src/company/tenant-test.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

test('1.4.038 schema upgrades without rewriting users, keys, VM identity or historical billing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-1454-upgrade-'))
  const migrations = path.join(dir, 'migrations')
  fs.mkdirSync(migrations)
  const source = path.resolve(import.meta.dirname, '../../src/lib/db/migrations')
  for (const file of fs.readdirSync(source)) {
    if (Number(file.split('_')[0]) <= 47) fs.copyFileSync(path.join(source, file), path.join(migrations, file))
  }
  const dbPath = path.join(dir, 'kin.db')
  let db = createDatabase({ dbPath, migrationsDir: migrations })
  try {
    db.exec(`
      INSERT INTO users(id,email,username,password_hash,role,concurrency) VALUES('tenant','fixture@example.test','fixture','opaque-password','user',24);
      INSERT INTO api_keys(id,name,key,status,user_id,quota_used,max_concurrency,key_secret) VALUES('key-fixture','client','opaque-key-hash','active','tenant',12.345678,24,'opaque-encrypted-key');
      INSERT INTO vms(id,name,vm_json) VALUES('vm-fixture','fixture','{"id":"vm-fixture","owner_user_id":"tenant","identity":"opaque-identity","proxy":"opaque-proxy"}');
      INSERT INTO usage_logs(id,request_id,created_at,user_id,vm_owner_user_id,total_cost,actual_cost,input_tokens,output_tokens) VALUES('bill','request','2026-11-01T00:00:00Z','tenant','tenant',0.123456789,0.246913578,1234,567);
    `)
    const tables = ['users', 'api_keys', 'vms', 'usage_logs']
    const before = Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => ({ ...row })),
      ]),
    )
    db.close()
    db = createDatabase({ dbPath })
    for (const table of tables) {
      const after = db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => {
          const value = { ...row }
          if (table === 'api_keys') {
            assert.equal(value.allowed_models, '[]')
            delete value.allowed_models
            assert.equal(value.api_endpoint_id, null)
            delete value.api_endpoint_id
          }
          if (table === 'usage_logs') {
            for (const added of ['usage_account_id', 'upstream_status', 'upstream_400_message']) {
              assert.equal(value[added], null)
              delete value[added]
            }
          }
          return value
        })
      assert.deepEqual(after, before[table], table)
    }
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tenant tests select only an owned, usable key covering the VM, without minting credentials', () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const store = new ApiKeyStore({ db, hashSecret: 'synthetic-upgrade-test' })
    store.users.insert({
      id: 'tenant',
      email: 'tenant@example.test',
      username: 'tenant',
      password_hash: 'fixture',
      role: 'user',
      concurrency: 12,
    })
    store.users.insert({
      id: 'other',
      email: 'other@example.test',
      username: 'other',
      password_hash: 'fixture',
      role: 'user',
    })
    const vm = { id: 'vm-owned', owner_user_id: 'tenant', platform: 'anthropic' }
    store.create({ name: 'foreign', user_id: 'other' })
    const own = store.create({
      name: 'own',
      user_id: 'tenant',
      group_type: 'anthropic',
      allowed_vms: [vm.id],
      max_concurrency: 1,
    })
    const read = () => tenantTestKey({ store, userId: 'tenant', vm })
    const count = store.list().length
    assert.equal(read(), own.key)
    assert.equal(tenantTestKey({ store, userId: 'other', vm }), null)
    assert.equal(store.acquire(store.getById(own.id)).ok, true)
    assert.equal(read(), null, 'concurrency remains enforced')
    store.release(own.id)
    store.update(own.id, { status: 'disabled' })
    assert.equal(read(), null)
    assert.equal(store.list().length, count)
  } finally {
    db.close()
  }
})
