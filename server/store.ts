// Adapted from OrderFlow db.js, orders.js and stats.js (MIT).
// See THIRD_PARTY_NOTICES.md for source revision and the changes for this booth.
import { createClient } from '@libsql/client/http'
import type { Config, InStatement } from '@libsql/client'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { localDatabase } from './local-database.ts'
import type { DatabaseClient, QueryTransaction } from './local-database.ts'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { AppError, draftSchema, menuSchema, milkOptionsFor, unitPriceCents, singaporeDay, progressStatuses, statuses, changeSchema, correctionSchema, revisionSchema } from '../shared/domain.ts'
import type { BoardOrder, Draft, GuestOrder, MenuItem, Order, OrderChange, OrderLine, Report, Role, Status } from '../shared/domain.ts'

const undoWindowMs = 10_000
const catalogVersion = 1
const initialMenu = [
  { id: 'espresso', name: 'Espresso', priceCents: 300, category: 'Coffee', description: 'A small, full-flavoured shot.' },
  { id: 'latte', name: 'Latte', priceCents: 800, category: 'Coffee', description: 'Espresso, a little milk, a lovely pause.' },
  { id: 'flat-white', name: 'Flat white', priceCents: 800, category: 'Coffee', description: 'Espresso with smooth, velvety milk.' },
  { id: 'americano', name: 'Americano', priceCents: 600, category: 'Coffee', description: 'Our house espresso, long and smooth.' },
  { id: 'pourover', name: 'Pourover', priceCents: 1000, category: 'Coffee', description: 'Hand-brewed, one cup at a time.' },
]

const localUrls = new WeakMap<DatabaseClient, string>()
const localTransactions = new Map<string, Promise<void>>()

export async function transact<T>(client: DatabaseClient, mode: 'read' | 'write', work: (tx: QueryTransaction) => Promise<T>): Promise<T> {
  const key = localUrls.get(client)
  const previous = key ? localTransactions.get(key) : undefined
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  // Local SQLite has one writer; queue in-process clients without blocking Node on a native lock.
  if (key) localTransactions.set(key, pending)
  await previous
  try { return await runTransaction(client, mode, work) }
  finally { if (key && localTransactions.get(key) === pending) localTransactions.delete(key); release() }
}

async function runTransaction<T>(client: DatabaseClient, mode: 'read' | 'write', work: (tx: QueryTransaction) => Promise<T>): Promise<T> {
  const tx = await client.transaction(mode)
  try { const result = await work(tx); await tx.commit(); return result }
  finally { tx.close() }
}

export const schema = [
  'CREATE TABLE IF NOT EXISTS menu (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS orders (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL, guest_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, event_day TEXT NOT NULL, anonymized_at TEXT, revision INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, menu_id TEXT NOT NULL, name TEXT NOT NULL,
    price INTEGER NOT NULL, qty INTEGER NOT NULL, milk TEXT NOT NULL, temperature TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id)',
  'CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(event_day)',
  `CREATE TABLE IF NOT EXISTS order_changes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id), action TEXT NOT NULL, reason TEXT NOT NULL,
    role TEXT NOT NULL, created_at TEXT NOT NULL, previous TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_changes_order ON order_changes(order_id, id)',
]

export class Store {
  db: DatabaseClient
  now: () => Date
  sourceId: string
  private constructor(db: DatabaseClient, now: () => Date, sourceId: string) { this.db = db; this.now = now; this.sourceId = sourceId }
  static async open(pathOrConfig: string | Config, now = () => new Date()): Promise<Store> {
    const config = typeof pathOrConfig === 'string'
      ? { url: pathOrConfig === ':memory:' ? 'file::memory:' : pathToFileURL(pathOrConfig).href }
      : pathOrConfig
    const db: DatabaseClient = config.url.startsWith('file:')
      ? localDatabase(config.url === 'file::memory:' ? ':memory:' : fileURLToPath(config.url))
      : createClient({ ...config, intMode: 'number' })
    if (config.url.startsWith('file:')) localUrls.set(db, config.url === 'file::memory:' ? `memory:${randomBytes(16).toString('hex')}` : config.url)
    try {
      if (config.url.startsWith('file:')) await db.executeMultiple('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;')
      await transact(db, 'write', async tx => {
        await tx.batch(schema)
        const columns = (await tx.execute('PRAGMA table_info(orders)')).rows
        if (!columns.some(column => column.name === 'revision')) await tx.execute('ALTER TABLE orders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
        if (!columns.some(column => column.name === 'anonymized_at')) await tx.execute('ALTER TABLE orders ADD COLUMN anonymized_at TEXT')
        const menu = (await tx.execute('SELECT data FROM menu')).rows.map(row => JSON.parse(row.data as string))
        // Keep the upgrade marker with menu data so backups retain later lead edits.
        if (!menu.some(item => item.catalogVersion === catalogVersion)) {
          await tx.execute('DELETE FROM menu')
          await tx.batch(initialMenu.map(item => ({ sql: 'INSERT INTO menu (id,data) VALUES (?,?)', args: [item.id, JSON.stringify({ ...item, available: true, catalogVersion })] })))
        }
        await tx.execute("DELETE FROM menu WHERE id IN ('cappuccino','black','mocha','chocolate','tea')")
      })
      return new Store(db, now, createHash('sha256').update(config.url).digest('hex'))
    } catch (error) { db.close(); throw error }
  }
  close() { this.db.close() }
  private async menuFrom(db: DatabaseClient | QueryTransaction): Promise<MenuItem[]> {
    return (await db.execute('SELECT data FROM menu ORDER BY rowid')).rows.map(row => JSON.parse(row.data as string))
  }
  async menu() { return transact(this.db, 'read', tx => this.menuFrom(tx)) }
  private async ordersFrom(tx: QueryTransaction, id?: string): Promise<Order[]> {
    const args = id === undefined ? [] : [id]
    const results = await tx.batch([
      { sql: 'SELECT * FROM orders' + (id === undefined ? '' : ' WHERE id=?') + ' ORDER BY number', args },
      { sql: 'SELECT * FROM order_items' + (id === undefined ? '' : ' WHERE order_id=?') + ' ORDER BY id', args },
      { sql: id === undefined
        ? `SELECT c.order_id,c.action,c.created_at FROM order_changes c JOIN
          (SELECT order_id,MAX(id) AS latest FROM order_changes GROUP BY order_id) last ON c.id=last.latest`
        : 'SELECT order_id,action,created_at FROM order_changes WHERE order_id=? ORDER BY id DESC LIMIT 1', args },
    ])
    const lines = new Map<string, OrderLine[]>()
    for (const row of results[1].rows) {
      const key = row.order_id as string
      if (!lines.has(key)) lines.set(key, [])
      lines.get(key)!.push({ menuId: row.menu_id as string, name: row.name as string, unitCents: Number(row.price), quantity: Number(row.qty), milk: row.milk as OrderLine['milk'], temperature: row.temperature as OrderLine['temperature'] })
    }
    const changes = new Map(results[2].rows.map(row => [row.order_id, row]))
    return results[0].rows.map(row => {
      const items = lines.get(row.id as string) ?? []
      const last = changes.get(row.id)
      return { id: row.id as string, number: Number(row.number), firstName: row.first_name as string,
        guestToken: row.guest_token as string, status: row.status as Status, createdAt: row.created_at as string,
        updatedAt: row.updated_at as string, eventDay: row.event_day as string, revision: Number(row.revision),
        lines: items, totalCents: items.reduce((sum, line) => sum + line.unitCents * line.quantity, 0),
        undoUntil: last?.action === 'advance' ? new Date(Date.parse(last.created_at as string) + undoWindowMs).toISOString() : undefined }
    })
  }
  async get(id: string) { return transact(this.db, 'read', async tx => (await this.ordersFrom(tx, id))[0] as Order | undefined) }
  async orders() { return transact(this.db, 'read', tx => this.ordersFrom(tx)) }
  async snapshot() { return transact(this.db, 'read', async tx => ({ orders: await this.ordersFrom(tx), menu: await this.menuFrom(tx), serverTime: this.now().toISOString(), sourceId: this.sourceId })) }
  private async priceLines(db: QueryTransaction, lines: Draft['lines'], previous?: Order): Promise<OrderLine[]> {
    const menu = await this.menuFrom(db)
    return lines.map(line => {
      const accepted = previous?.lines.find(old => old.menuId === line.menuId && old.milk === line.milk && old.temperature === line.temperature && old.unitCents === line.expectedUnitCents)
      if (accepted) return { ...line, name: accepted.name, unitCents: accepted.unitCents }
      const item = menu.find(item => item.id === line.menuId)
      if (!item) throw new AppError('That drink is no longer on the menu.')
      if (!item.available) throw new AppError(`${item.name} is sold out. Please review this order.`, 409)
      const options = milkOptionsFor(item.id)
      if (options.length ? !options.some(option => option.name === line.milk) : line.milk !== 'No milk') throw new AppError(options.length ? `${item.name} only offers regular milk or oat milk. Please review this order.` : `${item.name} is served without milk. Please review this order.`)
      const price = unitPriceCents(item, line)
      if (line.expectedUnitCents !== undefined && line.expectedUnitCents !== price) throw new AppError(`${item.name}'s price changed. Please review this order.`, 409)
      return { ...line, name: item.name, unitCents: price }
    })
  }
  private itemStatements(id: string, lines: OrderLine[]): InStatement[] {
    return lines.map(line => ({ sql: 'INSERT INTO order_items (order_id,menu_id,name,price,qty,milk,temperature) VALUES (?,?,?,?,?,?,?)', args: [id, line.menuId, line.name, line.unitCents, line.quantity, line.milk, line.temperature] }))
  }
  async create(input: unknown): Promise<Order> {
    const draft = draftSchema.parse(input)
    return transact(this.db, 'write', async tx => {
      const previous = (await this.ordersFrom(tx, draft.id))[0]
      if (previous) return previous
      const lines = await this.priceLines(tx, draft.lines)
      const now = this.now()
      await tx.batch([
        { sql: 'INSERT INTO orders (id,first_name,guest_token,created_at,updated_at,event_day) VALUES (?,?,?,?,?,?)', args: [draft.id, draft.firstName, randomBytes(24).toString('base64url'), now.toISOString(), now.toISOString(), singaporeDay(now)] },
        ...this.itemStatements(draft.id, lines),
      ])
      return (await this.ordersFrom(tx, draft.id))[0]
    })
  }
  private async checkedOrder(tx: QueryTransaction, id: string, revision?: number): Promise<Order> {
    if (revision !== undefined) revisionSchema.parse(revision)
    const order = (await this.ordersFrom(tx, id))[0]
    if (!order) throw new AppError('Order not found.', 404)
    if (revision !== undefined && order.revision !== revision) throw new AppError('This order changed on another device. Refresh before continuing.', 409)
    return order
  }
  private async historyFrom(db: DatabaseClient | QueryTransaction, id: string): Promise<OrderChange[]> {
    return (await db.execute({ sql: 'SELECT action,reason,role,created_at AS createdAt,previous FROM order_changes WHERE order_id=? ORDER BY id DESC', args: [id] })).rows.map(row => ({ action: row.action as OrderChange['action'], reason: row.reason as string, role: row.role as Role, createdAt: row.createdAt as string, previous: JSON.parse(row.previous as string) as Order }))
  }
  async history(id: string) { return transact(this.db, 'read', tx => this.historyFrom(tx, id)) }
  private async change(tx: QueryTransaction, order: Order, action: OrderChange['action'], reason: string, role: Role, statements: InStatement[]): Promise<Order> {
    await tx.batch([...statements, { sql: 'INSERT INTO order_changes (order_id,action,reason,role,created_at,previous) VALUES (?,?,?,?,?,?)', args: [order.id, action, reason, role, this.now().toISOString(), JSON.stringify(order)] }])
    return (await this.ordersFrom(tx, order.id))[0]
  }
  async transition(id: string, expected: Status, next: Status, role: Role = 'barista', revision?: number): Promise<Order> {
    z.enum(statuses).parse(expected); z.enum(statuses).parse(next)
    if (expected === 'cancelled' || next === 'cancelled' || progressStatuses.indexOf(next) !== progressStatuses.indexOf(expected) + 1) throw new AppError('Invalid order transition.')
    if (revision !== undefined) revisionSchema.parse(revision)
    return transact(this.db, 'write', async tx => {
      const order = await this.checkedOrder(tx, id)
      if (revision !== undefined && order.revision !== revision) {
        const last = (await this.historyFrom(tx, id))[0]
        if (order.status === next && order.revision === revision + 1 && last?.action === 'advance' && last.previous.revision === revision && last.previous.status === expected) return order
        throw new AppError('This order changed on another device. Review the current ticket before retrying.', 409)
      }
      if (order.status === next) return order
      if (order.status !== expected) throw new AppError('This order changed on another device. Refresh before continuing.', 409)
      return this.change(tx, order, 'advance', `${expected} → ${next}`, role, [{ sql: 'UPDATE orders SET status=?,updated_at=?,revision=revision+1 WHERE id=?', args: [next, this.now().toISOString(), id] }])
    })
  }
  async undo(id: string, revision: number, role: Role): Promise<Order> {
    revisionSchema.parse(revision)
    return transact(this.db, 'write', async tx => {
      const order = await this.checkedOrder(tx, id, revision)
      const last = (await this.historyFrom(tx, id))[0]
      if (last?.action !== 'advance') throw new AppError('There is no status change to undo.', 409)
      if (this.now().getTime() >= Date.parse(last.createdAt) + undoWindowMs) throw new AppError('Undo has expired. Ask the booth lead to review the order.', 409)
      return this.change(tx, order, 'undo', `Restored ${last.previous.status}`, role, [{ sql: 'UPDATE orders SET status=?,updated_at=?,revision=revision+1 WHERE id=?', args: [last.previous.status, this.now().toISOString(), id] }])
    })
  }
  async correct(id: string, input: unknown): Promise<Order> {
    const fields = correctionSchema.parse(input)
    return transact(this.db, 'write', async tx => {
      const order = await this.checkedOrder(tx, id, fields.revision)
      if (['collected', 'cancelled'].includes(order.status)) throw new AppError('Collected or cancelled orders cannot be edited.', 409)
      const lines = await this.priceLines(tx, fields.lines, order)
      const details = (items: OrderLine[]) => items.map(line => [line.menuId, line.milk, line.temperature, line.quantity, line.unitCents])
      const status = JSON.stringify(details(lines)) === JSON.stringify(details(order.lines)) ? order.status : 'queued'
      return this.change(tx, order, 'correct', fields.reason, 'lead', [
        { sql: 'UPDATE orders SET first_name=?,status=?,updated_at=?,revision=revision+1 WHERE id=?', args: [fields.firstName, status, this.now().toISOString(), id] },
        { sql: 'DELETE FROM order_items WHERE order_id=?', args: [id] }, ...this.itemStatements(id, lines),
      ])
    })
  }
  async cancel(id: string, input: unknown): Promise<Order> {
    const fields = changeSchema.parse(input)
    return transact(this.db, 'write', async tx => {
      const order = await this.checkedOrder(tx, id, fields.revision)
      if (order.status === 'cancelled') throw new AppError('This order is already cancelled.', 409)
      return this.change(tx, order, 'cancel', fields.reason, 'lead', [{ sql: "UPDATE orders SET status='cancelled',updated_at=?,revision=revision+1 WHERE id=?", args: [this.now().toISOString(), id] }])
    })
  }
  async guest(token: string): Promise<GuestOrder | undefined> {
    return transact(this.db, 'read', async tx => {
      const row = (await tx.execute({ sql: 'SELECT id FROM orders WHERE guest_token=? AND anonymized_at IS NULL', args: [token] })).rows[0]
      if (!row) return undefined
      const { number, firstName, lines, status, updatedAt } = (await this.ordersFrom(tx, row.id as string))[0]
      const ordersAhead = status === 'queued' ? Number((await tx.execute({ sql: "SELECT COUNT(*) AS count FROM orders WHERE number<? AND status IN ('queued','making')", args: [number] })).rows[0].count) : 0
      return { number, firstName, lines, status, updatedAt, ordersAhead }
    })
  }
  async board(): Promise<BoardOrder[]> { return transact(this.db, 'read', async tx => (await tx.execute("SELECT number,first_name AS firstName FROM orders WHERE status='ready' ORDER BY number")).rows as unknown as BoardOrder[]) }
  async saveMenu(id: string, input: unknown): Promise<MenuItem> {
    const fields = menuSchema.partial().refine(value => Object.keys(value).length > 0, 'Choose a field to update.').parse(input)
    return transact(this.db, 'write', async tx => {
      const existing = (await this.menuFrom(tx)).find(item => item.id === id)
      if (!existing) throw new AppError('Menu item not found.', 404)
      const updated = { ...existing, ...fields }
      await tx.execute({ sql: 'UPDATE menu SET data=? WHERE id=?', args: [JSON.stringify(updated), id] })
      return updated
    })
  }
  private validateDay(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new AppError('Choose a valid date.')
  }
  async report(date: string): Promise<Report> {
    this.validateDay(date)
    return transact(this.db, 'read', async tx => {
      const [totals, drinks] = await tx.batch([
        { sql: `SELECT COUNT(DISTINCT o.id) AS orders,COALESCE(SUM(i.price*i.qty),0) AS totalCents,COALESCE(SUM(i.qty),0) AS cups
          FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.event_day=? AND o.status<>'cancelled'`, args: [date] },
        { sql: `SELECT i.name,SUM(i.qty) AS cups,SUM(i.price*i.qty) AS totalCents FROM orders o JOIN order_items i ON i.order_id=o.id
          WHERE o.event_day=? AND o.status<>'cancelled' GROUP BY i.name ORDER BY cups DESC`, args: [date] },
      ])
      const total = totals.rows[0]
      return { date, orders: Number(total.orders), totalCents: Number(total.totalCents), cups: Number(total.cups), drinks: drinks.rows.map(row => ({ name: row.name as string, cups: Number(row.cups), totalCents: Number(row.totalCents) })) }
    })
  }
  async csv(date: string) {
    this.validateDay(date)
    const rows = await transact(this.db, 'read', async tx => (await tx.execute({ sql: `SELECT o.number,o.first_name,i.name,i.milk,i.temperature,i.qty,i.price,i.price*i.qty AS line_total,o.status
      FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.event_day=? ORDER BY o.number,i.id`, args: [date] })).rows)
    const escape = (value: unknown) => {
      const text = String(value ?? '').replace(/^[\s]*[=+@\-]/, match => `'${match}`)
      return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
    }
    const lines = ['event_day_sgt,order_number,first_name,drink,milk,temperature,quantity,unit_sgd,total_sgd,status']
    for (const row of rows) lines.push([date, row.number, row.first_name, row.name, row.milk, row.temperature, row.qty, (Number(row.price)/100).toFixed(2), (Number(row.line_total)/100).toFixed(2), row.status].map(escape).join(','))
    return '\uFEFF' + lines.join('\r\n') + '\r\n'
  }
}
