import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, RefreshCw, ExternalLink, Coffee, ClipboardList, CircleCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Brand } from '@/components/brand'
import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { Handoff } from '@/components/handoff'
import { OrderEntry } from './views/order-entry'
import { Queue } from './views/queue'
import { RecentOrders } from './views/recent'
import { MenuControls, Reports } from './views/lead'
import { GuestPage, ReadyBoard } from './views/public'
import { api } from './lib/api'
import { staffDB, useStaff } from './lib/staff'
import { enqueueStatus, projectOrders, cacheSnapshot } from './lib/offline'
import type { Pending } from './lib/offline'
import type { Draft, Order, Role } from '../shared/domain'

const sessionHint = 'beans-staff-hint'
function readHint(): Role | null {
  try { const hint = JSON.parse(localStorage.getItem(sessionHint) || 'null'); return hint?.expiresAt > Date.now() && ['lead', 'barista'].includes(hint.role) ? hint.role : null }
  catch { return null }
}

function Login({ login }: { login: (role: Role, password: string) => Promise<void> }) {
  const [role, setRole] = useState<Role>('barista')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await login(role, password) }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in.') }
    finally { setBusy(false) }
  }
  return <div className="login-shell"><header><Brand showEvent={false} /></header><main className="login-layout"><section><h1>Good coffee.<br /><em>Even better<br />together.</em></h1><p className="login-intro">A little rhythm behind the counter.<br />A little joy in every cup.</p><div className="login-charity"><img className="charity-mark" src="/brand/beans-and-beats-logo-black.png" alt="" width="60" height="60" /><p>Made for beans&beats.<br /><strong>In support of Young Hearts.</strong></p></div></section><section className="login-form-section"><p className="eyebrow">Welcome to the counter</p><h2>Let’s make some good.</h2><p className="quiet">Sign in to start your shift.</p><Tabs value={role} onValueChange={value => setRole(value as Role)}><TabsList className="login-roles"><TabsTrigger value="barista"><Coffee aria-hidden="true" />Barista</TabsTrigger><TabsTrigger value="lead"><ClipboardList aria-hidden="true" />Booth lead</TabsTrigger></TabsList></Tabs><form className="form-stack" onSubmit={submit}><Label htmlFor="password">Shift password</Label><Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required placeholder="Enter your password" />{error && <p className="error" role="alert">{error}</p>}<Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Start the shift'}<ArrowRight /></Button></form><Button asChild variant="link" className="login-board-link"><a href="/board">Open the ready board <ExternalLink size={14} /></a></Button></section></main></div>
}

function StaffApp() {
  const [role, setRole] = useState<Role | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(() => location.pathname.split('/')[2] || 'order')
  const [handoff, setHandoff] = useState<Order | null>(null)
  const [pendingOpen, setPendingOpen] = useState(false)
  const pendingTitleRef = useRef<HTMLHeadingElement>(null)
  const [discard, setDiscard] = useState<number | null>(null)
  const [restoring, setRestoring] = useState<Pending | null>(null)
  const [actionError, setActionError] = useState('')
  const [awaitingHandoffs, setAwaitingHandoffs] = useState<string[]>([])
  const [undoRequest, setUndoRequest] = useState<{ id: string; revision: number } | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const expired = useCallback(() => { setRole(null); localStorage.removeItem(sessionHint) }, [])
  const { snapshot, pending, connected, syncing, error, sync } = useStaff(role, expired)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), undoRequest ? 1000 : 30_000)
    return () => clearInterval(timer)
  }, [undoRequest])
  useEffect(() => {
    const order = snapshot?.orders.find(order => order.id === undoRequest?.id)
    if (!order || !undoRequest || order.revision <= undoRequest.revision) return
    const remaining = order.undoUntil ? Math.max(0, Date.parse(order.undoUntil) - Date.now()) : 0
    const timer = setTimeout(() => setUndoRequest(null), remaining)
    return () => clearTimeout(timer)
  }, [snapshot, undoRequest])
  useEffect(() => {
    if (handoff) return
    const confirmed = snapshot?.orders.find(order => awaitingHandoffs.includes(order.id))
    if (confirmed) {
      setAwaitingHandoffs(ids => ids.filter(id => id !== confirmed.id))
      if (!['collected', 'cancelled'].includes(confirmed.status)) setHandoff(confirmed)
    }
  }, [snapshot, awaitingHandoffs, handoff])
  useEffect(() => {
    api<{ role: Role }>('/session').then(result => setRole(result.role)).catch(error => { if (!(error.status === 401)) setRole(readHint()) }).finally(() => setLoading(false))
  }, [])
  function navigate(value: string) {
    setView(value)
    history.replaceState(null, '', `/staff/${value}`)
  }
  useEffect(() => {
    if (role && view === 'ready') navigate('queue')
    else if (role && (!['order', 'queue', 'recent', 'menu', 'reports'].includes(view) || (role === 'barista' && ['menu', 'reports'].includes(view)))) navigate('order')
  }, [role, view])
  async function login(nextRole: Role, password: string) {
    const result = await api<{ role: Role }>('/login', 'POST', { role: nextRole, password })
    try { localStorage.setItem(sessionHint, JSON.stringify({ role: result.role, expiresAt: Date.now() + 8 * 3600_000 })) } catch { /* Offline resume can use the current session until this tab closes. */ }
    setRole(result.role)
  }
  async function logout() {
    try { await api('/logout', 'POST', {}); expired() }
    catch { setActionError('Reconnect before signing out so the server session can be closed. Pending work is saved.') }
  }
  async function submit(draft: Draft) {
    const row: Pending = { kind: 'create', body: draft, label: `${draft.firstName} · ${draft.lines.length} drink ${draft.lines.length === 1 ? 'line' : 'lines'}`, createdAt: new Date().toISOString() }
    if (restoring) await staffDB.pending.put({ ...row, key: restoring.key })
    else await staffDB.pending.add(row)
    setRestoring(null)
    setAwaitingHandoffs(ids => [...ids, draft.id])
    void sync()
  }
  async function saveConfirmed(order: Order) {
    const cached = await staffDB.cache.get('snapshot')
    if (cached) await cacheSnapshot(staffDB, { ...cached.value, orders: [order], serverTime: new Date().toISOString() })
    void sync()
  }
  async function advance(order: Order) {
    setActionError('')
    try { await enqueueStatus(staffDB, order); setNow(Date.now()); setUndoRequest({ id: order.id, revision: order.revision ?? 0 }); void sync() }
    catch { setActionError('Could not save this change on this device. Please try again.') }
  }
  async function undo(order: Order) {
    setUndoBusy(true); setActionError('')
    try { await saveConfirmed(await api<Order>(`/orders/${order.id}/undo`, 'POST', { revision: order.revision })); setUndoRequest(null) }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not undo this change. Please try again.'); void sync() }
    finally { setUndoBusy(false) }
  }
  if (loading) return <div className="app-loading"><Coffee /><p>Opening the counter…</p></div>
  if (!role) return <Login login={login} />
  const orders = projectOrders(snapshot?.orders ?? [], pending)
  const rejected = pending.filter(row => Boolean(row.error))

  const active = orders.filter(order => ['queued', 'making', 'ready'].includes(order.status)).length
  const undoOrder = snapshot?.orders.find(order => order.id === undoRequest?.id && order.revision > undoRequest.revision && order.undoUntil && Date.parse(order.undoUntil) > now)
  const titles: Record<string, string> = { order: 'Order', queue: 'Queue', recent: 'Recent', menu: 'Menu', reports: 'Reports' }
  const title = titles[view] ?? 'Order'
  return <SidebarProvider className="staff-shell" defaultOpen={window.matchMedia('(min-width:1200px)').matches}>
    <AppSidebar role={role} view={view} active={active} connected={connected} syncing={syncing} pending={pending.length} rejected={rejected.length > 0} navigate={navigate} showPending={() => setPendingOpen(true)} logout={() => void logout()} />
    <SidebarInset className="staff-workspace">
      <SiteHeader title={title} />
      <div className="staff-content">
  {(!connected || pending.length > 0) && <div className="connection-banner" role="status"><span>{rejected.length ? <>{rejected.length === 1 ? '1 saved change was rejected.' : `${rejected.length} saved changes were rejected.`} {rejected[0].error} Review saved work to correct, retry, or discard it. {!connected && 'Connection paused. Work is saved on this device.'}</> : <>{!connected ? 'Connection paused. Work is saved on this device.' : 'Saved on this device. Waiting for confirmation.'} {pending.some(row => row.kind === 'create') ? 'New orders need confirmation before guest handoff.' : 'Local status changes reach other screens after confirmation.'}</>}</span><Button variant="link" onClick={() => setPendingOpen(true)}>{rejected.length ? 'Review rejected work' : 'View pending work'} <ArrowRight size={14} /></Button></div>}
  {(actionError || error) && <p className="error app-error" role="alert">{actionError || error}</p>}
  <div className="staff-main">{!snapshot ? <div className="queue-empty"><h1>Connecting to the counter.</h1><p>Connect once to load the menu before taking orders.</p><Button onClick={sync}>Try again</Button></div> : <><div hidden={view !== 'order'}><OrderEntry key={restoring?.key ?? 'new'} menu={snapshot.menu} submit={submit} initialDraft={restoring?.kind === 'create' ? restoring.body : undefined} cancelRestore={() => setRestoring(null)} /></div>{view === 'queue' && <div><Queue orders={orders} pending={pending} advance={advance} handoff={setHandoff} now={now} /></div>}{view === 'recent' && <div><RecentOrders orders={orders} menu={snapshot.menu} role={role} connected={connected} pending={pending} saved={saveConfirmed} undo={undo} now={now} /></div>}{role === 'lead' && <>{view === 'menu' && <div><MenuControls menu={snapshot.menu} sync={sync} connected={connected} /></div>}{view === 'reports' && <div><Reports revision={snapshot.serverTime} /></div>}</>}</>}
  </div></div>
  <div className="toast-viewport" role="status" aria-live="polite" aria-atomic="true">{undoOrder && <div className="undo-toast" key={`${undoOrder.id}-${undoOrder.revision}`}><CircleCheck aria-hidden="true" /><span>Order {String(undoOrder.number).padStart(3, '0')} status updated.</span><Button className="undo-toast-action" variant="outline" disabled={!connected || undoBusy || pending.some(row => row.body.id === undoOrder.id)} onClick={() => void undo(undoOrder)}>{undoBusy ? 'Undoing…' : 'Undo last change'}</Button><Button className="undo-toast-close" variant="ghost" size="icon" aria-label="Dismiss notification" disabled={undoBusy} onClick={() => setUndoRequest(null)}><X aria-hidden="true" /></Button></div>}</div>
  </SidebarInset>
  <Handoff order={handoff} close={() => setHandoff(null)} />
  <Dialog open={pendingOpen} onOpenChange={setPendingOpen}><DialogContent className="pending-dialog" onOpenAutoFocus={event => { event.preventDefault(); pendingTitleRef.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); (document.getElementById('staff-sync') ?? document.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]'))?.focus() }}><DialogHeader><DialogTitle ref={pendingTitleRef} tabIndex={-1}>Saved on this device.</DialogTitle><DialogDescription>Pending orders have no guest ticket yet. Reconnect to confirm them at the counter. Rejected changes stay here until you review them.</DialogDescription></DialogHeader><div className="pending-list">{pending.length ? pending.map(row => <div className="pending-row" key={row.key}><strong>{row.label}</strong>{row.kind === 'create' && <ul className="pending-details">{row.body.lines.map((line, index) => <li key={index}>{line.quantity} × {line.temperature} {snapshot?.menu.find(item => item.id === line.menuId)?.name ?? line.menuId} · {line.milk} milk{line.expectedUnitCents !== undefined ? ` · ${(line.expectedUnitCents / 100).toFixed(2)} each` : ''}</li>)}</ul>}<p className={row.error ? 'error' : 'quiet'}>{row.error || 'Waiting for the server to confirm.'}</p>{row.error && <div className="button-row">{row.kind === 'create' && <Button variant="outline" onClick={() => { setRestoring(row); navigate('order'); setPendingOpen(false) }}>Review order</Button>}<Button variant="outline" onClick={async () => { await staffDB.pending.update(row.key!, { error: undefined }); await sync() }}>Retry</Button><Button variant="ghost" onClick={() => setDiscard(row.key!)}>Discard…</Button></div>}{discard === row.key && <div className="discard-confirm"><p>Discard this local change permanently? Check with the guest or barista first.</p><div className="button-row"><Button variant="outline" onClick={() => setDiscard(null)}>Keep it</Button><Button variant="destructive" onClick={async () => { await staffDB.pending.delete(row.key!); setDiscard(null) }}>Discard change</Button></div></div>}</div>) : <p>All work is confirmed. You’re up to date.</p>}</div><Button disabled={syncing} onClick={sync}><RefreshCw className={syncing ? 'spin' : ''} />{syncing ? 'Syncing…' : 'Sync now'}</Button></DialogContent></Dialog>
  </SidebarProvider>
}

export default function App() {
  const guest = location.pathname.match(/^\/g\/([^/]+)$/)
  if (guest) return <GuestPage token={guest[1]} />
  if (location.pathname === '/board') return <ReadyBoard />
  return <StaffApp />
}
