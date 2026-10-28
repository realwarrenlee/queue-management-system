import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../server/store.ts'
import { localDatabase } from '../server/local-database.ts'
import { inspectDatabase } from '../server/maintenance.ts'
import { inspectRemoteDatabase, backupRemoteDatabase, restoreRemoteDatabase, anonymizeRemoteOrders } from '../server/remote-maintenance.ts'

const draft = () => ({ id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Oat', temperature: 'Iced', quantity: 2 }] })

test('remote-compatible backup and restore preserve orders, menu, history and the reserved ticket sequence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'beans-remote-maintenance-'))
  const stores: { close(): void }[] = []
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true }) })
  const original = await Store.open(join(directory, 'original.sqlite')); stores.push(original)
  const order = await original.create(draft())
  await original.transition(order.id, 'queued', 'making')
  await original.saveMenu('latte', { priceCents: 700, available: false })
  const snapshot = join(directory, 'snapshot.sqlite')
  assert.equal((await inspectRemoteDatabase(original.db)).orders, 1)
  assert.equal((await backupRemoteDatabase(original.db, snapshot)).nextTicket, 2)
  assert.equal(inspectDatabase(snapshot).changes, 1)
  const bytes = readFileSync(snapshot)
  const target = localDatabase(join(directory, 'destination.sqlite')); stores.push(target)
  await assert.rejects(restoreRemoteDatabase(target, snapshot, 0), /highest|issued/i)
  assert.equal((await restoreRemoteDatabase(target, snapshot, 100)).nextTicket, 101)
  await assert.rejects(restoreRemoteDatabase(target, snapshot, 100), /empty|populated/i)
  const restored = await Store.open(join(directory, 'destination.sqlite')); stores.push(restored)
  assert.equal((await restored.get(order.id))!.totalCents, 2000)
  assert.equal((await restored.guest(order.guestToken))!.status, 'making')
  assert.equal((await restored.history(order.id)).length, 1)
  assert.equal((await restored.menu()).find(item => item.id === 'latte')!.available, false)
  await restored.saveMenu('latte', { available: true })
  assert.equal((await restored.create(draft())).number, 101)
  assert.deepEqual(readFileSync(snapshot), bytes)
  await assert.rejects(backupRemoteDatabase(original.db, snapshot), /exist|overwrite/i)
})

test('remote privacy cleanup previews, revokes links and removes history while preserving reports', async () => {
  let now = new Date('2026-11-26T15:59:59Z')
  const store = await Store.open(':memory:', () => now)
  try {
    const order = await store.create(draft())
    await store.cancel(order.id, { revision: 0, reason: 'Guest changed plans' })
    const active = await store.create(draft())
    const report = await store.report('2026-11-26')
    now = new Date('2026-11-26T16:00:00Z')
    const boundary = await store.create(draft())
    await store.cancel(boundary.id, { revision: 0, reason: 'At cutoff' })
    assert.deepEqual(await anonymizeRemoteOrders(store.db, '2026-11-27'), { applied: false, matchingOrders: 1, ticketNumbers: [1] })
    assert.equal((await store.get(order.id))!.firstName, 'Alex')
    await assert.rejects(anonymizeRemoteOrders(store.db, '2026-02-31', true), /date|cutoff/i)
    assert.deepEqual(await anonymizeRemoteOrders(store.db, '2026-11-27', true), { applied: true, matchingOrders: 1, ticketNumbers: [1] })
    assert.equal(await store.guest(order.guestToken), undefined)
    assert.deepEqual(await store.history(order.id), [])
    assert.equal((await store.get(active.id))!.firstName, 'Alex')
    assert.equal((await store.get(boundary.id))!.firstName, 'Alex')
    assert.deepEqual(await store.report('2026-11-26'), report)
  } finally { store.close() }
})

test('a database error during history insertion rolls back the status update too', async () => {
  const store = await Store.open(':memory:')
  try {
    const order = await store.create(draft())
    await store.db.executeMultiple("CREATE TRIGGER reject_change BEFORE INSERT ON order_changes BEGIN SELECT RAISE(ABORT, 'History write failed'); END")
    await assert.rejects(store.transition(order.id, 'queued', 'making'), /History write failed/)
    assert.equal((await store.get(order.id))!.status, 'queued')
    assert.equal((await store.get(order.id))!.revision, 0)
    assert.deepEqual(await store.history(order.id), [])
  } finally { store.close() }
})
