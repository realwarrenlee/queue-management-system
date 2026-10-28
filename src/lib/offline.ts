// Adapted from OrderFlow's waiter.js pending/flush flow (MIT); see THIRD_PARTY_NOTICES.md.
import Dexie from 'dexie'
import type { Table } from 'dexie'
import { AppError, statuses, progressStatuses } from '../../shared/domain.ts'
import type { Draft, Snapshot, Status, Order } from '../../shared/domain.ts'

type PendingBase = { key?: number; label: string; createdAt: string; error?: string }
export type Pending = PendingBase & ({ kind: 'create'; body: Draft } | { kind: 'status'; body: { id: string; expected: Status; next: Status; revision: number } })
export class StaffDB extends Dexie {
  pending!: Table<Pending, number>
  cache!: Table<{ key: string; value: Snapshot }, string>
  constructor(name = 'beans-and-beats-staff-v1') {
    super(name)
    this.version(1).stores({ pending: '++key', cache: 'key' })
  }
}
export async function cacheSnapshot(db: StaffDB, snapshot: Snapshot) {
  await db.transaction('rw', db.cache, async () => {
    const cached = await db.cache.get('snapshot')
    const sameSource = !snapshot.sourceId || snapshot.sourceId === cached?.value.sourceId
    const orders = new Map((sameSource ? cached?.value.orders ?? [] : []).map(order => [order.id, order]))
    // Keep acknowledgements newer than an in-flight snapshot; orders are never deleted.
    for (const order of snapshot.orders) if ((order.revision ?? 0) >= (orders.get(order.id)?.revision ?? 0)) orders.set(order.id, order)
    await db.cache.put({ key: 'snapshot', value: { ...snapshot, sourceId: snapshot.sourceId ?? cached?.value.sourceId, orders: [...orders.values()].sort((a, b) => a.number - b.number) } })
  })
}
export function projectOrders(orders: Order[], pending: Pending[]): Order[] {
  return orders.map(order => pending.reduce((current, row) => row.kind === 'status' && !row.error && row.body.id === order.id && row.body.expected === current.status && row.body.revision === (current.revision ?? 0) && statuses.indexOf(row.body.next) > statuses.indexOf(current.status) ? { ...current, status: row.body.next, revision: (current.revision ?? 0) + 1, undoUntil: undefined } : current, order))
}

export async function enqueueStatus(db: StaffDB, order: Order) {
  await db.transaction('rw', db.cache, db.pending, async () => {
    const snapshot = await db.cache.get('snapshot')
    const current = projectOrders(snapshot?.value.orders ?? [], await db.pending.toArray()).find(row => row.id === order.id)
    if (!current || current.status !== order.status || (current.revision ?? 0) !== (order.revision ?? 0)) return
    if (current.status === 'cancelled') return
    const next = progressStatuses[progressStatuses.indexOf(current.status) + 1]
    if (next) await db.pending.add({ kind: 'status', body: { id: current.id, expected: current.status, next, revision: current.revision ?? 0 }, label: `${String(current.number).padStart(3, '0')} · ${current.firstName} → ${next}`, createdAt: new Date().toISOString() })
  })
}

const flushing = new WeakMap<StaffDB, Promise<void>>()
export function flushPending(db: StaffDB, send: (pending: Pending) => Promise<Order | void>): Promise<void> {
  const active = flushing.get(db)
  if (active) return active
  const run = async () => {
    try {
      while (true) {
        const pending = await db.pending.orderBy('key').filter(row => !row.error).first()
        if (!pending) break
        try {
          const confirmed = await send(pending)
          await db.transaction('rw', db.cache, db.pending, async () => {
            const cached = await db.cache.get('snapshot')
            if (confirmed && cached) await cacheSnapshot(db, { ...cached.value, orders: [confirmed] })
            // Keep the acknowledgement before deleting its command, even if refresh fails.
            await db.pending.delete(pending.key!)
          })
        } catch (error) {
          if (error instanceof AppError && error.status >= 400 && error.status < 500 && ![401, 429].includes(error.status)) {
            await db.pending.update(pending.key!, { error: error.message })
            continue
          }
          break
        }
      }
    } finally { flushing.delete(db) }
  }
  const promise = run()
  flushing.set(db, promise)
  return promise
}
