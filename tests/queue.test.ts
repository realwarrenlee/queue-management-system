import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import type { Order, Status } from '../shared/domain.ts'
import type { Pending } from '../src/lib/offline.ts'

test('Queue shows oldest unfinished tickets first with the action for their current stage', async t => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
  t.after(() => server.close())
  const { Queue } = await server.ssrLoadModule('/src/views/queue.tsx')
  const timestamp = '2026-10-20T00:00:00Z'
  const order = (number: number, status: Status): Order => ({
    id: `queue-order-${number}`, number, firstName: `Guest ${number}`, status,
    lines: [{ menuId: 'latte', name: 'Latte', milk: 'Dairy', temperature: 'Hot', quantity: 1, unitCents: 500 }],
    totalCents: 500, guestToken: `guest-${number}`, createdAt: timestamp, updatedAt: timestamp, eventDay: '2026-10-20', revision: 0,
  })
  const orders = [order(1, 'ready'), order(2, 'making'), order(3, 'queued'), order(4, 'collected'), order(5, 'cancelled')]
  function rows(tickets: Order[], pending: Pending[] = []) {
    const html = renderToStaticMarkup(createElement(Queue, { orders: tickets, pending, advance: () => {}, handoff: () => {}, now: Date.parse(timestamp) }))
    const body = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? ''
    return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1])
  }
  const initial = rows(orders)
  assert.equal(initial.length, 3, 'ready tickets stay in the same table; collected and cancelled tickets are excluded')
  for (let index = 0; index < initial.length; index++) assert.ok(initial[index].includes(`Show tracking QR for order ${index + 1}`), 'older tickets appear first regardless of status')
  assert.deepEqual(rows([...orders].reverse()), initial, 'incoming ticket order does not affect the oldest-first display')
  assert.match(initial[0], />Collected<\/button>/)
  assert.match(initial[1], />Ready<\/button>/)
  assert.match(initial[2], />Start<\/button>/)

  const rush = Array.from({ length: 41 }, (_, index) => order(41 - index, 'queued'))
  rush[40].createdAt = '2026-10-19T23:50:00Z'
  const rushRows = rows(rush)
  assert.ok(rushRows[0].includes('Show tracking QR for order 1'), 'the oldest ticket stays first during a rush of 41 orders')
  assert.match(rushRows[0], />10 min<\/td>/, 'the ticket waiting ten minutes is visible first')

  const collected = rows(orders.map(ticket => ticket.number === 1 ? { ...ticket, status: 'collected' } : ticket))
  assert.equal(collected.length, 2)
  assert.ok(!collected.some(row => row.includes('Show tracking QR for order 1')))

  const rejected: Pending = { kind: 'status', body: { id: orders[0].id, expected: 'ready', next: 'collected', revision: 0 }, label: '', createdAt: timestamp, error: 'Order changed on another device' }
  assert.match(rows(orders, [rejected])[0], /disabled=""[^>]*>Collected<\/button>/, 'rejected pending work still blocks the action')
})
