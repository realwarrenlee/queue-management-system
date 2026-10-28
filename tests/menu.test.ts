import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store, schema } from '../server/store.ts'

const draft = (menuId: string, milk = 'No milk', temperature = 'Hot', quantity = 1, expectedUnitCents?: number) => ({
  id: randomUUID(), firstName: 'Alex', lines: [{ menuId, milk, temperature, quantity, expectedUnitCents }],
})
const confirmedMenu = [
  ['espresso', 'Espresso', 300], ['latte', 'Latte', 800], ['flat-white', 'Flat white', 800],
  ['americano', 'Americano', 600], ['pourover', 'Pourover', 1000],
]

test('new orders use the five confirmed drinks with per-cup iced and oat surcharges', async t => {
  const store = await Store.open(':memory:'); t.after(() => store.close())
  assert.deepEqual((await store.menu()).map(item => [item.id, item.name, item.priceCents]), confirmedMenu)
  for (const [id, milk, temperature, want] of [
    ['espresso', 'No milk', 'Hot', 300], ['espresso', 'No milk', 'Iced', 400],
    ['latte', 'Dairy', 'Hot', 800], ['latte', 'Dairy', 'Iced', 900],
    ['latte', 'Oat', 'Hot', 900], ['latte', 'Oat', 'Iced', 1000],
    ['flat-white', 'Dairy', 'Hot', 800], ['flat-white', 'Oat', 'Iced', 1000],
    ['americano', 'No milk', 'Hot', 600], ['americano', 'No milk', 'Iced', 700],
    ['pourover', 'No milk', 'Hot', 1000], ['pourover', 'No milk', 'Iced', 1100],
  ] as const) {
    const order = await store.create(draft(id, milk, temperature, 2, want))
    assert.equal(order.lines[0].unitCents, want, `${temperature} ${milk} ${id}`)
    assert.equal(order.totalCents, want * 2)
  }
})

test('new orders reject unsupported milk combinations and retired drinks without consuming tickets', async t => {
  const store = await Store.open(':memory:'); t.after(() => store.close())
  for (const id of ['espresso', 'americano', 'pourover']) {
    for (const milk of ['Dairy', 'Oat', 'Soy']) await assert.rejects(store.create(draft(id, milk)), /milk/i)
  }
  for (const id of ['latte', 'flat-white']) {
    for (const milk of ['No milk', 'Soy']) await assert.rejects(store.create(draft(id, milk)), /milk/i)
  }
  for (const id of ['black', 'cappuccino', 'mocha', 'chocolate', 'tea']) await assert.rejects(store.create(draft(id)), /menu/i)
  assert.deepEqual(await store.orders(), [])
  assert.equal((await store.create(draft('latte', 'Dairy'))).number, 1)
})

test('iced and oat prices reach reports and CSV and stale offline prices are rejected', async t => {
  const store = await Store.open(':memory:', () => new Date('2026-11-26T02:00:00Z')); t.after(() => store.close())
  await assert.rejects(store.create(draft('latte', 'Oat', 'Iced', 2, 900)), /price changed/i)
  const order = await store.create(draft('latte', 'Oat', 'Iced', 2, 1000))
  assert.equal(order.number, 1)
  assert.equal((await store.report('2026-11-26')).totalCents, 2000)
  assert.match(await store.csv('2026-11-26'), /Latte,Oat,Iced,2,10\.00,20\.00/)
  assert.deepEqual(await store.create({ ...draft('latte', 'Oat', 'Iced'), id: order.id }), order)
})

test('changing temperature reprices a correction while unchanged drinks retain accepted prices', async t => {
  const store = await Store.open(':memory:'); t.after(() => store.close())
  const order = await store.create(draft('latte', 'Dairy'))
  const correction = { revision: order.revision, firstName: 'Alex', reason: 'Guest wants iced', lines: [{ ...order.lines[0], temperature: 'Iced', expectedUnitCents: order.lines[0].unitCents }] }
  await assert.rejects(store.correct(order.id, correction), /price changed/i)
  assert.equal((await store.get(order.id))!.revision, 0)
  const iced = await store.correct(order.id, { ...correction, lines: [{ ...correction.lines[0], expectedUnitCents: 900 }] })
  assert.equal(iced.totalCents, 900)
  const hot = await store.correct(order.id, { ...correction, revision: iced.revision, lines: [{ ...iced.lines[0], temperature: 'Hot', expectedUnitCents: 800 }] })
  assert.equal(hot.totalCents, 800)
  await store.saveMenu('latte', { priceCents: 950, available: false })
  const renamed = await store.correct(order.id, { ...correction, firstName: 'Alexa', revision: hot.revision, lines: hot.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) })
  assert.equal(renamed.totalCents, 800)
})

test('legacy catalog upgrades once, preserving historical orders, later menu edits and ticket numbering', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'beans-menu-'))
  const stores: Store[] = []
  t.after(() => { stores.forEach(store => store.close()); rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'legacy.sqlite')
  const db = new DatabaseSync(path)
  db.exec(schema.join(';'))
  for (const [id, name, priceCents] of [['latte', 'Latte', 500], ['mocha', 'Mocha', 600], ['black', 'Black coffee', 400]] as const) {
    db.prepare('INSERT INTO menu (id,data) VALUES (?,?)').run(id, JSON.stringify({ id, name, priceCents, available: true, category: 'Coffee', description: 'Legacy drink' }))
  }
  db.exec(`INSERT INTO orders (number,id,first_name,guest_token,status,created_at,updated_at,event_day) VALUES (41,'legacy-order','Alex','legacy-token','ready','2026-10-20T02:00:00Z','2026-10-20T02:00:00Z','2026-10-20');
    INSERT INTO order_items (order_id,menu_id,name,price,qty,milk,temperature) VALUES ('legacy-order','mocha','Mocha',680,2,'Soy','Iced')`)
  db.close()
  let store = await Store.open(path); stores.push(store)
  assert.deepEqual((await store.menu()).map(item => [item.id, item.name, item.priceCents]), confirmedMenu)
  const legacy = (await store.get('legacy-order'))!
  assert.equal(legacy.totalCents, 1360)
  assert.equal((await store.guest('legacy-token'))!.lines[0].milk, 'Soy')
  const renamed = await store.correct(legacy.id, { revision: 0, reason: 'Correct name', firstName: 'Alexa', lines: legacy.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) })
  assert.equal(renamed.totalCents, 1360)
  assert.equal(renamed.status, 'ready')
  await store.saveMenu('latte', { priceCents: 850, available: false })
  stores.pop()!.close()
  store = await Store.open(path); stores.push(store)
  assert.equal((await store.menu()).length, 5)
  assert.equal((await store.menu()).find(item => item.id === 'latte')!.priceCents, 850)
  assert.equal((await store.menu()).find(item => item.id === 'latte')!.available, false)
  assert.equal((await store.create(draft('espresso'))).number, 42)
  assert.equal((await store.get(legacy.id))!.totalCents, 1360)
})

test('startup removes retired drinks reseeded by an older server without resetting current menu edits', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'beans-reseed-'))
  let store = await Store.open(join(directory, 'orders.sqlite'))
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const order = await store.create(draft('latte', 'Oat', 'Iced', 1, 1000))
  await store.saveMenu('latte', { priceCents: 850, available: false })
  await store.db.execute({ sql: 'INSERT INTO menu (id,data) VALUES (?,?)', args: ['cappuccino', JSON.stringify({ id: 'cappuccino', name: 'Cappuccino', priceCents: 500, available: true, category: 'Coffee', description: 'Legacy default' })] })
  store.close()
  store = await Store.open(join(directory, 'orders.sqlite'))
  assert.deepEqual((await store.menu()).map(item => item.id), ['espresso', 'latte', 'flat-white', 'americano', 'pourover'])
  assert.equal((await store.menu()).find(item => item.id === 'latte')!.priceCents, 850)
  assert.equal((await store.menu()).find(item => item.id === 'latte')!.available, false)
  assert.equal((await store.get(order.id))!.totalCents, 1000)
})
