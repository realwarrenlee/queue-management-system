import { Coffee, QrCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table'
import { statusText, ticket } from '../../shared/domain'
import type { Order, Status } from '../../shared/domain'
import type { Pending } from '@/lib/offline'

export function StatusLabel({ status }: { status: Status }) { return <span className={`status-label status-${status}`}><span aria-hidden="true" />{statusText[status]}</span> }
export function Queue({ orders, pending, advance, handoff, now }: { orders: Order[]; pending: Pending[]; advance: (order: Order) => void; handoff: (order: Order) => void; now: number }) {
  const active = orders.filter(order => ['queued', 'making', 'ready'].includes(order.status)).sort((a, b) => a.number - b.number)
  const ready = active.filter(order => order.status === 'ready').length
  const making = active.filter(order => order.status === 'making').length
  const elapsed = (order: Order) => Math.max(0, Math.floor((now - Date.parse(order.createdAt)) / 60_000))
  const waiting = active.filter(order => order.status === 'queued')
  return <section className="queue-page"><div className="page-heading"><h1>On the counter.</h1><p className="page-subtitle">{active.length ? `${active.length} active ${active.length === 1 ? 'order' : 'orders'}.` : 'A quiet moment. Ready for the next order.'}</p><dl className="service-summary" aria-label="Counter overview"><div><dt>Waiting</dt><dd>{waiting.length}</dd></div><div><dt>Making</dt><dd>{making}</dd></div><div><dt>Ready</dt><dd>{ready}</dd></div><div><dt>Longest wait</dt><dd>{waiting.length ? `${Math.max(...waiting.map(elapsed))} min` : '—'}</dd></div><div><dt>Pending changes</dt><dd>{pending.length}</dd></div></dl></div>
  <Table className="staff-table queue-table"><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Drink</TableHead><TableHead>Milk</TableHead><TableHead>Elapsed</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{active.map(order => {
    const hasPending = pending.some(row => row.body.id === order.id)
    const blocked = pending.some(row => row.body.id === order.id && !!row.error)
    return <TableRow key={order.id}><TableCell><Button variant="link" className="table-ticket" onClick={() => handoff(order)} aria-label={`Show tracking QR for order ${order.number}`}>{ticket(order.number)}</Button></TableCell><TableCell>{order.firstName}</TableCell><TableCell className="drink-cell">{order.lines.map((line, index) => <div key={index}><strong>{line.quantity > 1 ? `${line.quantity} × ` : ''}{line.temperature === 'Iced' ? 'Iced ' : ''}{line.name}</strong></div>)}</TableCell><TableCell>{order.lines.map((line, index) => <div key={index}>{line.milk}</div>)}</TableCell><TableCell className="elapsed-time">{elapsed(order)} min</TableCell><TableCell><StatusLabel status={order.status} />{hasPending && <small className="pending-hint">Change pending</small>}</TableCell><TableCell className="text-right"><Button className="table-action" variant="outline" disabled={blocked} onClick={() => advance(order)}>{order.status === 'queued' ? 'Start' : order.status === 'making' ? 'Ready' : 'Collected'}</Button></TableCell></TableRow>
  })}</TableBody></Table>{!active.length && <div className="queue-empty"><Coffee size={42} strokeWidth={1} /><h2>Good things are brewing.</h2><p>Confirmed orders will appear here, oldest first.</p></div>}
  <div className="queue-footnote"><span>Oldest first. Tap a number for its guest QR.</span><QrCode size={16} /></div>
  </section>
}
