import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { databaseConfig } from '../server/database.ts'

test('local development keeps its SQLite path while complete Turso credentials select remote storage', () => {
  assert.equal(databaseConfig({}), resolve('data', 'beans.sqlite'))
  assert.equal(databaseConfig({ DB_PATH: './local.sqlite' }), resolve('local.sqlite'))
  assert.deepEqual(databaseConfig({ TURSO_DATABASE_URL: 'libsql://counter.turso.io', TURSO_AUTH_TOKEN: 'private-token', DB_PATH: './ignored.sqlite' }), { url: 'libsql://counter.turso.io', authToken: 'private-token' })
})

test('cloud hosts and incomplete Turso settings fail rather than save orders to ephemeral storage', () => {
  for (const env of [
    { RENDER: 'true' }, { VERCEL: '1' },
    { TURSO_DATABASE_URL: 'libsql://counter.turso.io' }, { TURSO_AUTH_TOKEN: 'private-token' },
    { TURSO_DATABASE_URL: ' ', TURSO_AUTH_TOKEN: ' ' },
  ]) assert.throws(() => databaseConfig(env), /TURSO_DATABASE_URL.*TURSO_AUTH_TOKEN/)
  for (const url of ['http://counter.turso.io', 'file:local.sqlite', 'libsql://counter.turso.io?tls=0', 'https://user:password@counter.turso.io']) {
    assert.throws(() => databaseConfig({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'private-token' }), /secure|URL/i)
  }
})
