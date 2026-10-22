import express from 'express'
import type { RequestHandler, ErrorRequestHandler } from 'express'
import cookieSession from 'cookie-session'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { AppError, statuses, revisionSchema } from '../shared/domain.ts'
import { hashPassword, verifyPassword } from './password.ts'
import type { Store } from './store.ts'

type Config = { secret: string; baristaPassword: string; leadPassword: string; production: boolean }

export function createApp(store: Store, config: Config) {
  const app = express()
  app.disable('x-powered-by')
  if (config.production) app.set('trust proxy', 1)
  app.use(express.json({ limit: '64kb' }))
  app.use(cookieSession({ name: 'beans-session', keys: [config.secret], maxAge: 8 * 3600_000, httpOnly: true, secure: config.production, sameSite: 'strict' }))
  const passwords = { barista: hashPassword(config.baristaPassword), lead: hashPassword(config.leadPassword) }
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin')
      if (!origin || new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Open this page from the app address before making changes.' })
      if (!req.is('application/json')) return res.status(415).json({ error: 'Use a JSON request.' })
    }
    next()
  })
  const staff: RequestHandler = (req, _res, next) => {
    if (!req.session?.role || req.session.expiresAt < Date.now()) return next(new AppError('Sign in to continue. Your pending work is saved.', 401))
    next()
  }
  const lead: RequestHandler = (req, _res, next) => req.session?.role === 'lead' ? next() : next(new AppError('Booth lead access is required.', 403))
  app.post('/api/login', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), (req, res) => {
    const { role, password } = z.object({ role: z.enum(['barista', 'lead']), password: z.string().max(256) }).parse(req.body)
    if (!verifyPassword(password, passwords[role])) throw new AppError('That password does not match. Please try again.', 401)
    req.session = { role, expiresAt: Date.now() + 8 * 3600_000 }
    res.json({ role })
  })
  app.get('/api/session', staff, (req, res) => res.json({ role: req.session!.role }))
  app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }) })
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.get('/api/guest/:token', async (req, res) => {
    const order = await store.guest(z.string().parse(req.params.token))
    if (!order) throw new AppError('We could not find that order. Please check your link with the counter.', 404)
    res.json(order)
  })
  app.get('/api/board', async (_req, res) => res.json(await store.board()))
  app.get('/api/snapshot', staff, async (_req, res) => res.json(await store.snapshot()))
  app.post('/api/orders', staff, async (req, res) => res.status(201).json(await store.create(req.body)))
  app.post('/api/orders/:id/status', staff, async (req, res) => {
    const { expected, next } = z.object({ expected: z.enum(statuses), next: z.enum(statuses) }).parse(req.body)
    if (req.body.revision === undefined) throw new AppError('This saved status change needs review. Open the current ticket before updating it.', 409)
    res.json(await store.transition(z.string().parse(req.params.id), expected, next, req.session!.role, revisionSchema.parse(req.body.revision)))
  })
  app.post('/api/orders/:id/undo', staff, async (req, res) => res.json(await store.undo(z.string().parse(req.params.id), revisionSchema.parse(req.body.revision), req.session!.role)))
  app.patch('/api/orders/:id', staff, lead, async (req, res) => res.json(await store.correct(z.string().parse(req.params.id), req.body)))
  app.post('/api/orders/:id/cancel', staff, lead, async (req, res) => res.json(await store.cancel(z.string().parse(req.params.id), req.body)))
  app.get('/api/orders/:id/history', staff, lead, async (req, res) => {
    const id = z.string().parse(req.params.id)
    if (!await store.get(id)) throw new AppError('Order not found.', 404)
    res.json(await store.history(id))
  })
  app.patch('/api/menu/:id', staff, lead, async (req, res) => res.json(await store.saveMenu(z.string().parse(req.params.id), req.body)))
  app.get('/api/reports/:day', staff, lead, async (req, res) => res.json(await store.report(z.string().parse(req.params.day))))
  app.get('/api/reports/:day/csv', staff, lead, async (req, res) => {
    const csv = await store.csv(z.string().parse(req.params.day))
    res.setHeader('Content-Disposition', `attachment; filename="beans-orders-${req.params.day}.csv"`)
    res.type('text/csv').send(csv)
  })
  app.use('/api', (_req, res) => res.status(404).json({ error: 'That endpoint does not exist.' }))
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'Please check the form.' })
    const status = error instanceof AppError ? error.status : error.status === 400 ? 400 : 500
    if (status === 500) console.error(error)
    res.status(status).json({ error: status === 500 ? 'Could not save this change. Please try again.' : error.message })
  }
  app.use(errors)
  return app
}
