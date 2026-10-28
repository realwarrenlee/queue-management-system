import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { api } from '@/lib/api'
import { drinkLabel, money, ticket, statusText } from '../../shared/domain'
import type { Draft, MenuItem, Order, OrderChange, Role } from '../../shared/domain'
import type { Pending } from '@/lib/offline'
import { OrderEntry } from './order-entry'
import { StatusLabel } from './queue'

export function RecentOrders({ orders, menu, role, connected, pending, saved, undo, now }: { orders: Order[]; menu: MenuItem[]; role: Role; connected: boolean; pending: Pending[]; saved: (order: Order) => Promise<void>; undo: (order: Order) => Promise<void>; now: number }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Order | null>(null)
  const [cancelling, setCancelling] = useState<Order | null>(null)
  const [reason, setReason] = useState('')
  const [history, setHistory] = useState<OrderChange[]>([])
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = orders.find(order => order.id === selectedId)
  const blocked = !connected || busy || pending.some(row => row.body.id === selectedId)
  const recentOrders = [...orders].reverse()
  useEffect(() => {
    let active = true
    setHistory([]); setHistoryError('')
    if (selected && role === 'lead') api<OrderChange[]>(`/orders/${selected.id}/history`).then(value => { if (active) setHistory(value) }).catch(() => { if (active) setHistoryError('Change history could not refresh. Reopen this order after reconnecting.') })
    return () => { active = false }
  }, [selected?.id, selected?.revision, role])
  async function correct(draft: Draft, correctionReason?: string) {
    if (!editing) return
    const updated = await api<Order>(`/orders/${editing.id}`, 'PATCH', { ...draft, revision: editing.revision, reason: correctionReason })
    await saved(updated)
    setEditing(null)
  }
  async function cancel() {
    if (!cancelling) return
    setBusy(true); setError('')
    try {
      const updated = await api<Order>(`/orders/${cancelling.id}/cancel`, 'POST', { revision: cancelling.revision, reason })
      await saved(updated)
      setCancelling(null); setReason('')
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not cancel this order. Please try again.') }
    finally { setBusy(false) }
  }
  return <section className="recent-page">
    <div className="page-heading"><h1>Recent orders.</h1><p className="page-subtitle">Including collected and cancelled orders.</p></div>
    <Table className="staff-table recent-table"><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Drinks</TableHead><TableHead>Status</TableHead><TableHead className="numeric">Value</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{recentOrders.flatMap(order => order.lines.map((line, index) => <TableRow key={`${order.id}-${index}`} className={`${order.lines.length > 1 ? 'recent-order-line' : ''} ${index < order.lines.length - 1 ? 'recent-order-continues' : ''}`}>
      {index === 0 && <><TableCell rowSpan={order.lines.length}><strong className="font-semibold tabular-nums">{ticket(order.number)}</strong></TableCell><TableCell rowSpan={order.lines.length}>{order.firstName}</TableCell></>}
      <TableCell>{line.quantity} × {line.temperature} {drinkLabel(line)}</TableCell>
      {index === 0 && <><TableCell rowSpan={order.lines.length}><StatusLabel status={order.status} /></TableCell><TableCell rowSpan={order.lines.length} className="numeric">{money(order.totalCents)}</TableCell>
      <TableCell rowSpan={order.lines.length} className="text-right"><Button className="table-action" variant="outline" aria-label={`Edit order ${order.number}`} onClick={() => { setSelectedId(order.id); setError(''); setCancelling(null); setReason('') }}>Edit</Button></TableCell></>}
    </TableRow>))}</TableBody></Table>
    {!recentOrders.length && <p className="section-note">No orders yet.</p>}<p className="section-note">Newest first. Tap Edit to review an order.</p>
    <Dialog open={!!selected} onOpenChange={open => { if (!open && !busy) { setSelectedId(null); setCancelling(null) } }}><DialogContent className="recent-dialog"><DialogHeader><DialogTitle>Order {selected && ticket(selected.number)} · {selected?.firstName}</DialogTitle><DialogDescription>Review the ticket before making a change. Payments and refunds are handled separately on the organiser’s POS.</DialogDescription></DialogHeader>
      {selected && <><StatusLabel status={selected.status} /><ul className="order-details">{selected.lines.map((line, index) => <li key={index}>{line.quantity} × {line.temperature} {drinkLabel(line)}</li>)}</ul><strong>{money(selected.totalCents)}</strong>
        {!connected && <p className="notice">Reconnect before undoing, correcting or cancelling an order.</p>}
        {pending.some(row => row.body.id === selected.id) && <p className="notice">Wait for this order’s pending changes to be confirmed before reviewing it.</p>}
        {selected.undoUntil && Date.parse(selected.undoUntil) > now && <Button disabled={blocked} variant="outline" onClick={() => void undo(selected)}>Undo last status change</Button>}
        {role === 'lead' && <div className="button-row">
          {!['collected', 'cancelled'].includes(selected.status) && <Button disabled={blocked} variant="outline" onClick={() => { setEditing(selected); setSelectedId(null) }}>Correct order</Button>}
          {selected.status !== 'cancelled' && <Button disabled={blocked} variant="outline" onClick={() => { setCancelling(selected); setError(''); setReason('') }}>Cancel order…</Button>}
        </div>}
        {cancelling && <form className="cancel-confirm form-stack" onSubmit={event => { event.preventDefault(); void cancel() }}><p>Cancel order {ticket(cancelling.number)}? It will leave the queue and recorded totals. Its ticket and change history will be retained.</p><Label htmlFor="cancel-reason">Reason for cancellation</Label><Input id="cancel-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={200} required disabled={busy} />{error && <p className="error" role="alert">{error}</p>}<div className="button-row"><Button type="button" variant="outline" disabled={busy} onClick={() => setCancelling(null)}>Keep order</Button><Button type="submit" variant="destructive" disabled={blocked}>{busy ? 'Cancelling…' : 'Confirm cancellation'}</Button></div></form>}
        {role === 'lead' && <div className="order-history"><h2>Change history.</h2>{historyError && <p className="error" role="alert">{historyError}</p>}{!history.length && !historyError && <p className="quiet">No changes recorded for this ticket.</p>}{history.map((change, index) => <div key={index}><strong>{change.action === 'advance' ? 'Status changed' : change.action === 'undo' ? 'Status restored' : change.action === 'correct' ? 'Order corrected' : 'Order cancelled'}</strong><p>{change.reason}</p><p className="quiet">{new Date(change.createdAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT · {change.role === 'lead' ? 'Booth lead' : 'Barista'}</p>{change.action === 'correct' && <p className="quiet">Before: {change.previous.firstName} · {change.previous.lines.map(line => `${line.quantity} × ${line.temperature} ${drinkLabel(line)}`).join('; ')} · {money(change.previous.totalCents)} · {statusText[change.previous.status]}</p>}</div>)}</div>}
      </>}
    </DialogContent></Dialog>
    <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null) }}><DialogContent className="correction-dialog"><DialogHeader><DialogTitle>Correct the confirmed order.</DialogTitle><DialogDescription>Keep the same ticket and tracking link. Remove incorrect drinks and add their replacements. A reason is required.</DialogDescription></DialogHeader>{editing && <OrderEntry key={editing.id} menu={menu} acceptedOrder={editing} submit={correct} />}</DialogContent></Dialog>
  </section>
}
