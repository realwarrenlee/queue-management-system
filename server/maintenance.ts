import { DatabaseSync, backup } from 'node:sqlite'
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export type DatabaseSummary = { orders: number; drinkLines: number; changes: number; nextTicket: number }
const sidecars = ['-wal', '-shm', '-journal']

export function validateDatabase(db: DatabaseSync): DatabaseSummary {
  if (db.prepare('PRAGMA quick_check').all().some(row => Object.values(row)[0] !== 'ok')) throw new Error('Database integrity check failed.')
  for (const query of [
    'SELECT id,number,first_name,guest_token,status,created_at,updated_at,event_day,revision FROM orders LIMIT 0',
    'SELECT id,order_id,menu_id,name,price,qty,milk,temperature FROM order_items LIMIT 0',
    'SELECT id,data FROM menu LIMIT 0',
    'SELECT id,order_id,action,reason,role,created_at,previous FROM order_changes LIMIT 0',
  ]) db.prepare(query).all()
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database foreign-key check failed.')
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM orders) AS orders,
    (SELECT COUNT(*) FROM order_items) AS drinkLines, (SELECT COUNT(*) FROM order_changes) AS changes,
    MAX(COALESCE((SELECT MAX(number) FROM orders),0), COALESCE((SELECT seq FROM sqlite_sequence WHERE name='orders'),0))+1 AS nextTicket`).get()!
  if (!Number.isSafeInteger(counts.nextTicket)) throw new Error('Ticket sequence is outside the supported range.')
  return { orders: Number(counts.orders), drinkLines: Number(counts.drinkLines), changes: Number(counts.changes), nextTicket: Number(counts.nextTicket) }
}

function openSource(path: string, readOnly = true) {
  if (!statSync(path).isFile()) throw new Error('Choose an existing SQLite database file.')
  return new DatabaseSync(path, { readOnly, timeout: 5000 })
}

export function inspectDatabase(path: string): DatabaseSummary {
  const db = openSource(path)
  try { return validateDatabase(db) } finally { db.close() }
}

async function snapshot(source: string, destination: string, lastIssued?: number): Promise<DatabaseSummary> {
  const target = resolve(destination)
  if ([target, ...sidecars.map(suffix => target + suffix)].some(path => existsSync(path))) throw new Error('Destination or SQLite sidecar already exists. Choose a new file; nothing will be overwritten.')
  if (lastIssued !== undefined && (!Number.isSafeInteger(lastIssued) || lastIssued < 0)) throw new Error('Highest issued ticket must be a non-negative safe integer.')
  const sourceDb = openSource(source)
  let stagingDirectory: string | undefined
  try {
    validateDatabase(sourceDb)
    mkdirSync(dirname(target), { recursive: true })
    stagingDirectory = mkdtempSync(join(dirname(target), '.beans-snapshot-'))
    const stagingPath = join(stagingDirectory, 'snapshot.sqlite')
    await backup(sourceDb, stagingPath)
    const staged = new DatabaseSync(stagingPath)
    let summary: DatabaseSummary
    try {
      // Publish a standalone snapshot rather than a main file depending on a WAL.
      staged.exec('PRAGMA journal_mode=DELETE')
      summary = validateDatabase(staged)
      if (lastIssued !== undefined) {
        if (lastIssued < summary.nextTicket - 1 || lastIssued === Number.MAX_SAFE_INTEGER) throw new Error(`Highest issued ticket must be at least ${summary.nextTicket - 1} and leave room for the next ticket.`)
        if (!staged.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='orders'").run(lastIssued).changes) staged.prepare("INSERT INTO sqlite_sequence (name,seq) VALUES ('orders',?)").run(lastIssued)
        summary = validateDatabase(staged)
      }
    } finally { staged.close() }
    chmodSync(stagingPath, 0o600)
    // COPYFILE_EXCL also protects against a destination appearing after validation.
    copyFileSync(stagingPath, target, constants.COPYFILE_EXCL)
    return summary
  } finally {
    sourceDb.close()
    if (stagingDirectory) {
      for (const suffix of ['', ...sidecars]) { const path = join(stagingDirectory, 'snapshot.sqlite' + suffix); if (existsSync(path)) unlinkSync(path) }
      rmdirSync(stagingDirectory)
    }
  }
}

export function backupDatabase(source: string, destination: string) { return snapshot(source, destination) }
export function restoreDatabase(source: string, destination: string, lastIssued: number) {
  if (lastIssued === undefined) return Promise.reject(new Error('Supply the highest issued ticket number before restoring.'))
  return snapshot(source, destination, lastIssued)
}

export function privacyCutoff(before: string) {
  const parsed = Date.parse(`${before}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== before) throw new Error('Supply a valid cutoff date as YYYY-MM-DD (Singapore midnight).')
  return new Date(`${before}T00:00:00+08:00`).toISOString()
}

export function anonymizeOrders(source: string, before: string, apply = false) {
  const cutoff = privacyCutoff(before)
  const db = openSource(source, !apply)
  let transaction = false
  let committed = false
  try {
    validateDatabase(db)
    if (!db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'anonymized_at')) throw new Error('Open this database with the updated app once before using privacy cleanup.')
    if (apply) { db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE'); transaction = true }
    const matches = db.prepare("SELECT id,number FROM orders WHERE anonymized_at IS NULL AND status IN ('collected','cancelled') AND updated_at<? ORDER BY number").all(cutoff)
    if (apply) {
      const update = db.prepare("UPDATE orders SET first_name='Guest', guest_token=?, anonymized_at=?, updated_at=?, revision=revision+1 WHERE id=?")
      const history = db.prepare('DELETE FROM order_changes WHERE order_id=?')
      const at = new Date().toISOString()
      for (const row of matches) { history.run(row.id); update.run(randomBytes(24).toString('base64url'), at, at, row.id) }
      db.exec('COMMIT'); transaction = false; committed = true
      if (matches.length) {
        db.exec('VACUUM')
        if (Number(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy)) throw new Error('Other database connections prevented WAL cleanup. Stop them and complete compaction/checkpoint before returning the database to service.')
      }
    }
    return { applied: apply, matchingOrders: matches.length, ticketNumbers: matches.map(row => Number(row.number)) }
  } catch (error) {
    if (transaction) db.exec('ROLLBACK')
    if (committed) throw new Error('Ticket anonymization was committed, but storage cleanup failed. Keep the server stopped and investigate before restarting.', { cause: error })
    throw error
  } finally { db.close() }
}
