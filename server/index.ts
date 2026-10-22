import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import express from 'express'
import { createApp } from './app.ts'
import { Store } from './store.ts'
import { databaseConfig } from './database.ts'

const production = process.env.NODE_ENV === 'production'
const baristaPassword = process.env.BARISTA_PASSWORD || 'barista-demo'
const leadPassword = process.env.LEAD_PASSWORD || 'lead-demo'
const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex')
if (production && (!process.env.SESSION_SECRET || secret.length < 32 || baristaPassword === 'barista-demo' || leadPassword === 'lead-demo' || baristaPassword.length < 12 || leadPassword.length < 12)) throw new Error('Set SESSION_SECRET (32+ characters), BARISTA_PASSWORD and LEAD_PASSWORD (12+ characters each) before production startup.')
const database = databaseConfig()
if (typeof database === 'string') mkdirSync(resolve(database, '..'), { recursive: true })
const store = await Store.open(database)
const app = createApp(store, { secret, baristaPassword, leadPassword, production })
const publicPath = resolve('dist')
app.use(express.static(publicPath, { setHeaders(res, path) { if (path.endsWith('sw.js') || path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache') } }))
app.get('/{*path}', (_req, res) => res.sendFile(resolve(publicPath, 'index.html')))
const port = Number(process.env.PORT || 3001)
const host = production ? '0.0.0.0' : '127.0.0.1'
const server = app.listen(port, host, () => console.log(`beans&beats ${production ? '' : '(local development) '}http://${host}:${port}`))
const stop = () => server.close(() => { store.close(); process.exit(0) })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
