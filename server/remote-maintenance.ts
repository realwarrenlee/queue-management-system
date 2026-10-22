import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { schema, transact } from './store.ts'
import { backupDatabase, privacyCutoff, validateDatabase } from './maintenance.ts'
import type { DatabaseSummary } from './maintenance.ts'
import type { DatabaseClient, QueryTransaction } from './local-database.ts'
import type { InStatement } from '@libsql/client'

const tables = [
  { name: 'menu', columns: ['id', 'data'] },
  { name: 'orders', columns: ['number', 'id', 'first_name', 'guest_token', 'status', 'created_at', 'updated_at', 'event_day', 'anonymized_at', 'revision'] },
  { name: 'order_items', columns: ['id', 'order_id', 'menu_id', 'name', 'price', 'qty', 'milk', 'temperature'] },
  { name: 'order_changes', columns: ['id', 'order_id', 'action', 'reason', 'role', 'created_at', 'previous'] },
]
const queries = tables.map(table => `SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`)
const sequenceQuery = "SELECT name,seq FROM sqlite_sequence WHERE name IN ('orders','order_items','order_changes')"
const countQuery = `SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM order_items) AS drinkLines,
  (SELECT COUNT(*) FROM order_changes) AS changes,
  MAX(COALESCE((SELECT MAX(number) FROM orders),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='orders'),0))+1 AS nextTicket`
type StoredRow = Record<string, string | number | null>
type Snapshot = { rows: StoredRow[][]; sequences: StoredRow[]; summary: DatabaseSummary }

async function validateRemote(tx: QueryTransaction): Promise<DatabaseSummary> {
  const checked = await tx.batch(['PRAGMA quick_check', 'PRAGMA foreign_key_check', ...tables.map(table => `SELECT ${table.columns.join(',')} FROM ${table.name} LIMIT 0`), countQuery])
  if (checked[0].rows.some(row => Object.values(row)[0] !== 'ok')) throw new Error('Database integrity check failed.')
  if (checked[1].rows.length) throw new Error('Database foreign-key check failed.')
  const counts = checked.at(-1)!.rows[0]
  const summary = { orders: Number(counts.orders), drinkLines: Number(counts.drinkLines), changes: Number(counts.changes), nextTicket: Number(counts.nextTicket) }
  if (!Number.isSafeInteger(summary.nextTicket)) throw new Error('Ticket sequence is outside the supported range.')
  return summary
}

export function inspectRemoteDatabase(client: DatabaseClient) {
  return transact(client, 'read', validateRemote)
}

function inserts(snapshot: Snapshot, lastIssued?: number): InStatement[] {
  const statements: InStatement[] = []
  for (const [index, table] of tables.entries()) for (const row of snapshot.rows[index]) {
    statements.push({ sql: `INSERT INTO ${table.name} (${table.columns.join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`, args: table.columns.map(column => row[column]) })
  }
  statements.push("DELETE FROM sqlite_sequence WHERE name IN ('orders','order_items','order_changes')")
  const sequences = snapshot.sequences.map(row => ({ name: row.name as string, seq: Number(row.seq) }))
  if (!sequences.some(row => row.name === 'orders')) sequences.push({ name: 'orders', seq: 0 })
  for (const row of sequences) statements.push({ sql: 'INSERT INTO sqlite_sequence (name,seq) VALUES (?,?)', args: [row.name, row.name === 'orders' && lastIssued !== undefined ? Math.max(row.seq, lastIssued) : row.seq] })
  return statements
}

export async function backupRemoteDatabase(client: DatabaseClient, destination: string): Promise<DatabaseSummary> {
  const snapshot = await transact(client, 'read', async tx => {
    const summary = await validateRemote(tx)
    const results = await tx.batch([...queries, sequenceQuery])
    return { rows: results.slice(0, 4).map(result => result.rows as unknown as StoredRow[]), sequences: results[4].rows as unknown as StoredRow[], summary }
  })
  const directory = mkdtempSync(join(tmpdir(), 'beans-remote-backup-'))
  const path = join(directory, 'snapshot.sqlite')
  try {
    const db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      db.exec(schema.join(';') + '; BEGIN IMMEDIATE')
      for (const statement of inserts(snapshot)) {
        if (typeof statement === 'string') db.exec(statement)
        else db.prepare(statement.sql).run(...statement.args as (string | number | null)[])
      }
      db.exec('COMMIT')
      validateDatabase(db)
    } finally { db.close() }
    return await backupDatabase(path, destination)
  } finally { rmSync(directory, { recursive: true }) }
}

function localSnapshot(source: string): Snapshot {
  if (!statSync(source).isFile()) throw new Error('Choose an existing SQLite snapshot file.')
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.exec('BEGIN')
    const summary = validateDatabase(db)
    const rows = queries.map(query => db.prepare(query).all() as StoredRow[])
    const sequences = db.prepare(sequenceQuery).all() as StoredRow[]
    db.exec('COMMIT')
    return { rows, sequences, summary }
  } finally { db.close() }
}

export async function restoreRemoteDatabase(client: DatabaseClient, source: string, lastIssued: number): Promise<DatabaseSummary> {
  const snapshot = localSnapshot(source)
  if (!Number.isSafeInteger(lastIssued) || lastIssued < snapshot.summary.nextTicket - 1 || lastIssued === Number.MAX_SAFE_INTEGER) throw new Error(`Highest issued ticket must be a safe integer of at least ${snapshot.summary.nextTicket - 1} and leave room for the next ticket.`)
  return transact(client, 'write', async tx => {
    const existing = (await tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows
    for (const row of existing) {
      const table = tables.find(table => table.name === row.name)
      if (!table || Number((await tx.execute(`SELECT COUNT(*) AS count FROM ${table.name}`)).rows[0].count)) throw new Error('Restore requires an empty database. The destination is populated; nothing was overwritten.')
    }
    await tx.batch([...schema, ...inserts(snapshot, lastIssued)])
    return validateRemote(tx)
  })
}

export async function anonymizeRemoteOrders(client: DatabaseClient, before: string, apply = false) {
  const cutoff = privacyCutoff(before)
  return transact(client, apply ? 'write' : 'read', async tx => {
    await validateRemote(tx)
    const matches = (await tx.execute({ sql: "SELECT id,number FROM orders WHERE anonymized_at IS NULL AND status IN ('collected','cancelled') AND updated_at<? ORDER BY number", args: [cutoff] })).rows
    if (apply && matches.length) {
      const at = new Date().toISOString()
      await tx.batch(matches.flatMap(row => [
        { sql: 'DELETE FROM order_changes WHERE order_id=?', args: [row.id] },
        { sql: "UPDATE orders SET first_name='Guest',guest_token=?,anonymized_at=?,updated_at=?,revision=revision+1 WHERE id=?", args: [randomBytes(24).toString('base64url'), at, at, row.id] },
      ]))
    }
    return { applied: apply, matchingOrders: matches.length, ticketNumbers: matches.map(row => Number(row.number)) }
  })
}
