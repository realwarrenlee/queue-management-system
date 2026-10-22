import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../server/store.ts'

test('remote maintenance requires credentials and never echoes a private token on configuration errors', () => {
  const env = { ...process.env, TURSO_DATABASE_URL: undefined, TURSO_AUTH_TOKEN: undefined, RENDER: undefined, VERCEL: undefined }
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/database.ts', ...args], { encoding: 'utf8', env })
  const missing = run('check', '--remote')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /TURSO_DATABASE_URL.*TURSO_AUTH_TOKEN/)
  const invalid = spawnSync(process.execPath, ['scripts/database.ts', 'check'], { encoding: 'utf8', env: { ...env, TURSO_DATABASE_URL: 'http://unsafe.example', TURSO_AUTH_TOKEN: 'never-print-this-token' } })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /secure|URL/i)
  assert.ok(!invalid.stderr.includes('never-print-this-token'))
})

test('an explicit local maintenance source overrides Turso environment settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'beans-cli-routing-'))
  const path = join(directory, 'local.sqlite')
  const store = await Store.open(path); store.close()
  try {
    const checked = spawnSync(process.execPath, ['scripts/database.ts', 'check', '--source', path], { encoding: 'utf8', env: { ...process.env, TURSO_DATABASE_URL: 'not-a-url', TURSO_AUTH_TOKEN: 'private-token' } })
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(JSON.parse(checked.stdout).orders, 0)
  } finally { rmSync(directory, { recursive: true }) }
})
