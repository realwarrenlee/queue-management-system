import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../server/store.ts'

const draft = () => ({ id: randomUUID(), firstName: 'Alex', lines: [{ menuId: 'latte', milk: 'Oat', temperature: 'Iced', quantity: 2 }] })

test('the async store opens SQLite and preserves accepted orders across separate clients', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'beans-turso-'))
  const path = join(directory, 'orders.sqlite')
  const stores: Store[] = []
  try {
    const first = await Store.open(path); stores.push(first)
    const second = await Store.open(path); stores.push(second)
    const input = draft()
    const [a, b] = await Promise.all([first.create(input), second.create(input)])
    assert.equal(a.id, b.id)
    assert.equal(a.number, b.number)
    assert.equal((await second.orders()).length, 1)
    assert.equal((await second.get(a.id))!.lines.length, 1)
    const [c, d] = await Promise.all([first.create(draft()), second.create(draft())])
    assert.deepEqual([c.number, d.number].sort((x, y) => x - y), [2, 3])
    const making = await first.transition(a.id, 'queued', 'making', 'barista', 0)
    const renamed = await second.correct(a.id, { firstName: 'Alexa', reason: 'Name correction', revision: making.revision, lines: making.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) })
    await assert.rejects(first.transition(a.id, 'making', 'ready', 'barista', making.revision), /changed/i)
    assert.equal((await first.get(a.id))!.revision, renamed.revision)
    assert.equal((await first.get(a.id))!.firstName, 'Alexa')
    assert.equal((await first.history(a.id)).length, 2)
  } finally {
    stores.forEach(store => store.close())
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a rejected drink rolls back the entire async order and does not consume a ticket', async () => {
  const store = await Store.open(':memory:')
  try {
    const input = draft()
    await assert.rejects(store.create({ ...input, lines: [...input.lines, { ...input.lines[0], menuId: 'missing' }] }), /menu/i)
    assert.deepEqual(await store.orders(), [])
    assert.equal((await store.create(draft())).number, 1)
  } finally { store.close() }
})
