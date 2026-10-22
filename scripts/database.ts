import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { anonymizeOrders, backupDatabase, inspectDatabase, restoreDatabase } from '../server/maintenance.ts'
import { inspectRemoteDatabase, backupRemoteDatabase, restoreRemoteDatabase, anonymizeRemoteOrders } from '../server/remote-maintenance.ts'
import { databaseConfig } from '../server/database.ts'
import { createClient } from '@libsql/client/http'

const action = process.argv[2]
const source = { type: 'string' as const }
const remote = { type: 'boolean' as const }
const options: Record<string, ParseArgsOptionsConfig> = {
  check: { source, remote },
  backup: { source, remote, to: { type: 'string' as const } },
  restore: { remote, from: { type: 'string' as const }, to: { type: 'string' as const }, 'last-issued': { type: 'string' as const } },
  privacy: { source, remote, before: { type: 'string' as const }, apply: { type: 'boolean' as const } },
}

try {
  if (!Object.hasOwn(options, action)) throw new Error('Choose check, backup, restore or privacy. See docs/booth-operations.md for commands.')
  const { values } = parseArgs({ args: process.argv.slice(3), options: options[action], strict: true, allowPositionals: false })
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && !value.trim()) throw new Error(`--${name} cannot be empty or blank.`)
  if (values.remote && values.source !== undefined) throw new Error('Choose --remote or --source <local-file>, not both.')
  if (action === 'restore' && (!values.from || typeof values['last-issued'] !== 'string' || !/^\d+$/.test(values['last-issued']) || (!values.remote && !values.to))) throw new Error('Restore requires --from <backup>, --last-issued <highest-issued-ticket>, and either --remote or --to <new-local-file>. Stop service and reconcile devices before restoring.')
  if (action === 'restore' && values.remote && values.to !== undefined) throw new Error('Remote restore uses the configured Turso database. Omit --to or use local restore instead.')
  if (action === 'privacy' && typeof values.before !== 'string') throw new Error('Privacy cleanup requires --before YYYY-MM-DD. Preview is read-only; --apply needs an approved cutoff and writes paused.')
  const useRemote = values.remote === true || (action !== 'restore' && values.source === undefined && (process.env.TURSO_DATABASE_URL !== undefined || process.env.TURSO_AUTH_TOKEN !== undefined || process.env.RENDER === 'true' || process.env.VERCEL === '1'))
  const destination = action === 'backup' ? resolve(String(values.to || `backups/beans-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.sqlite`)) : undefined
  let result: object
  if (useRemote) {
    const config = databaseConfig()
    if (typeof config === 'string') throw new Error('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for remote maintenance.')
    const client = createClient({ ...config, intMode: 'number' })
    try {
      if (action === 'check') result = { database: 'turso', ...await inspectRemoteDatabase(client) }
      else if (action === 'backup') result = { database: 'turso', path: destination, ...await backupRemoteDatabase(client, destination!) }
      else if (action === 'restore') result = { database: 'turso', ...await restoreRemoteDatabase(client, String(values.from), Number(values['last-issued'])) }
      else result = { database: 'turso', before: values.before, ...await anonymizeRemoteOrders(client, String(values.before), values.apply === true) }
    } finally { client.close() }
  } else {
    const database = resolve(String(values.source || process.env.DB_PATH || 'data/beans.sqlite'))
    if (action === 'check') result = { path: database, ...inspectDatabase(database) }
    else if (action === 'backup') {
      result = { path: destination, ...await backupDatabase(database, destination!) }
    } else if (action === 'restore') {
      const destination = resolve(String(values.to))
      result = { path: destination, ...await restoreDatabase(String(values.from), destination, Number(values['last-issued'])) }
    } else {
      result = { path: database, before: values.before, ...anonymizeOrders(database, String(values.before), values.apply === true) }
    }
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Maintenance failed.')
  process.exitCode = 1
}
