import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { Store } from '../server/store.ts'

test('Menu shows all seven drink choices with their full names and oat-inclusive prices', async t => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
  const store = await Store.open(':memory:')
  t.after(async () => { store.close(); await server.close() })
  const { MenuControls } = await server.ssrLoadModule('/src/views/lead.tsx')
  const html = renderToStaticMarkup(createElement(MenuControls, { menu: await store.menu(), sync: async () => {}, connected: true }))
  const body = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? ''
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1])
  assert.equal(rows.length, 7)
  for (const [index, label, price] of [
    [0, 'Espresso', '3.00'], [1, 'Latte', '8.00'], [2, 'Latte (oat milk)', '9.00'],
    [3, 'Flat white', '8.00'], [4, 'Flat white (oat milk)', '9.00'], [5, 'Americano', '6.00'], [6, 'Pourover', '10.00'],
  ] as const) {
    assert.ok(rows[index].includes(`>${label}</strong>`), `${label} must be a complete menu row`)
    assert.ok(rows[index].includes(`$${price}`), `${label} must show its full hot-drink price`)
  }
})
