import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Plus, Minus, Trash2, ShoppingBag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog'
import { milkOptions, money, draftSchema, ticket } from '../../shared/domain'
import type { Draft, MenuItem, Order } from '../../shared/domain'

type CartLine = Draft['lines'][number] & { name: string }
export function OrderEntry({ menu, submit, initialDraft, cancelRestore, acceptedOrder }: { menu: MenuItem[]; submit: (draft: Draft, reason?: string) => Promise<void>; initialDraft?: Draft; cancelRestore?: () => void; acceptedOrder?: Order }) {
  const fieldId = useId()
  const drinkGridRef = useRef<HTMLDivElement>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [milk, setMilk] = useState<Draft['lines'][number]['milk']>('No milk')
  const [temperature, setTemperature] = useState<'Hot' | 'Iced' | ''>('')
  const [quantity, setQuantity] = useState(1)
  const [firstName, setFirstName] = useState(acceptedOrder?.firstName ?? initialDraft?.firstName ?? '')
  const [cart, setCart] = useState<CartLine[]>(() => acceptedOrder ? acceptedOrder.lines.map(line => ({ ...line, expectedUnitCents: line.unitCents })) : initialDraft?.lines.map(line => { const item = menu.find(item => item.id === line.menuId); return { ...line, name: item?.name ?? 'Unavailable drink', expectedUnitCents: item ? item.priceCents + milkOptions.find(option => option.name === line.milk)!.extraCents : line.expectedUnitCents ?? 0 } }) ?? [])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = menu.find(item => item.id === selectedId)
  const unitCents = selected ? selected.priceCents + milkOptions.find(option => option.name === milk)!.extraCents : 0
  const total = cart.reduce((sum, line) => sum + line.expectedUnitCents! * line.quantity, 0)
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0)
  function add() {
    if (!selected?.available || !temperature) return
    setCart([...cart, { menuId: selected.id, name: selected.name, milk, temperature, quantity, expectedUnitCents: unitCents }])
    setSelectedId(''); setMilk('No milk'); setTemperature(''); setQuantity(1); setError('')
  }
  async function place(event: FormEvent) {
    event.preventDefault()
    setError('')
    const parsed = draftSchema.safeParse({ id: acceptedOrder?.id ?? initialDraft?.id ?? crypto.randomUUID(), firstName, lines: cart })
    if (!parsed.success) { setError(cart.length ? 'Enter a first name, up to 40 characters.' : 'Add at least one drink to the order.'); return }
    setBusy(true)
    try {
      await submit(parsed.data, reason)
      if (!acceptedOrder) { setCart([]); setFirstName(''); setReviewOpen(false) }
    } catch (error) { setError(acceptedOrder && error instanceof Error ? error.message : 'Could not save this order on this device. Keep the details here and try again.') }
    finally { setBusy(false) }
  }
  const summary = <form onSubmit={place}><fieldset disabled={busy} className="order-review-fields">
    <div className="name-field"><Label htmlFor={`${fieldId}-name`}>Guest’s first name</Label><Input id={`${fieldId}-name`} autoComplete="off" placeholder="Who’s the coffee for?" value={firstName} onChange={event => setFirstName(event.target.value)} maxLength={40} required /></div>
    <div className="cart-lines">{cart.length ? cart.map((line, index) => <div className="cart-line" key={index}><div><strong>{line.quantity} × {line.temperature === 'Iced' ? 'Iced ' : ''}{line.name}</strong><p>{line.milk}{line.milk !== 'No milk' ? ' milk' : ''}</p></div><span>{money(line.expectedUnitCents! * line.quantity)}</span><Button variant="ghost" size="icon" type="button" aria-label={`Remove ${line.name} from order`} onClick={() => setCart(cart.filter((_, row) => row !== index))}><Trash2 size={15} /></Button></div>) : <div className="cart-empty"><ShoppingBag size={30} strokeWidth={1.2} /><p>A cup of good starts here.</p></div>}</div>
    <div className="order-total"><span>Order total</span><strong>{money(total)}</strong></div><p className="field-note">Payment is taken separately on the organiser’s POS.</p>
    {acceptedOrder && <div className="correction-reason"><Label htmlFor="correction-reason">Reason for correction</Label><Input id="correction-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={200} required /></div>}
    {error && <p className="error" role="alert">{error}</p>}
    <Button className="place-order" type="submit" disabled={busy || !cart.length}>{busy ? 'Saving…' : acceptedOrder ? 'Save correction' : 'Place order'}<ArrowRight /></Button>
  </fieldset></form>
  return <fieldset disabled={busy} className={`order-layout${acceptedOrder ? '' : ' order-entry'}`}><section className="menu-section">
    {initialDraft && <div className="notice">Review the saved order with the guest. Prices below use the current menu; remove any unavailable drink. The original stays saved until you place the corrected order.<Button variant="link" onClick={cancelRestore}>Cancel review</Button></div>}
    <div className="page-heading"><h1>{acceptedOrder ? `Correct order ${ticket(acceptedOrder.number)}.` : 'What can we make?'}</h1><p className="page-subtitle">{acceptedOrder ? 'Kept drinks retain their accepted prices. Added or replaced drinks use today’s menu. Changing drinks returns the ticket to Waiting. Confirm with the guest and barista.' : 'A good cup, for a good cause.'}</p></div>
    <div ref={drinkGridRef} className="drink-grid" role="group" aria-label="Drinks" tabIndex={-1}>{menu.map(item => <Button key={item.id} variant="outline" className={`drink-tile ${selectedId === item.id ? 'selected' : ''}`} disabled={!item.available} onClick={() => setSelectedId(item.id)} aria-pressed={selectedId === item.id}>
      <span className="drink-name">{item.name}</span><span className="drink-bottom">{item.available ? money(item.priceCents) : 'Sold out'}</span>
    </Button>)}</div>
    <div className="customize"><div><Label htmlFor={`${fieldId}-milk`}>Milk</Label><Select value={milk} onValueChange={value => setMilk(value as typeof milk)}><SelectTrigger id={`${fieldId}-milk`}><SelectValue>{milk}</SelectValue></SelectTrigger><SelectContent position="popper">{milkOptions.map(option => <SelectItem key={option.name} value={option.name}>{option.name}{option.extraCents ? ` +${money(option.extraCents)}` : ''}</SelectItem>)}</SelectContent></Select></div>
    <fieldset><legend>Temperature</legend><RadioGroup className="temperature-options" aria-label="Temperature" value={temperature} onValueChange={value => setTemperature(value as typeof temperature)}>{['Hot', 'Iced'].map(value => <Label className={`temperature-label ${temperature === value ? 'chosen' : ''}`} key={value}><RadioGroupItem value={value} />{value}</Label>)}</RadioGroup></fieldset>
    <div><Label>Quantity</Label><div className="stepper"><Button type="button" variant="ghost" size="icon" aria-label="Reduce quantity" disabled={quantity <= 1} onClick={() => setQuantity(quantity - 1)}><Minus /></Button><output aria-live="polite">{quantity}</output><Button type="button" variant="ghost" size="icon" aria-label="Increase quantity" disabled={quantity >= 20} onClick={() => setQuantity(quantity + 1)}><Plus /></Button></div></div></div>
    <Button className="add-drink" variant="outline" onClick={add} disabled={!selected?.available || !temperature || cart.length >= 20}><Plus /> Add {selected?.name ?? 'drink'} {selected && <span>{money(unitCents * quantity)}</span>}</Button>
    {!acceptedOrder && <Dialog open={reviewOpen} onOpenChange={open => { if (!busy) setReviewOpen(open) }}>
      <div className="order-review-bar"><DialogTrigger asChild><Button data-slot="button" className="review-order" type="button" disabled={!cart.length} aria-label={`Review order, ${itemCount} ${itemCount === 1 ? 'drink' : 'drinks'}`}><ShoppingBag /><span>Review order <Badge variant="secondary" className="review-order-count" aria-hidden="true">{itemCount}</Badge></span><ArrowRight /></Button></DialogTrigger></div>
      <DialogContent className="order-review-dialog" showCloseButton={!busy} onCloseAutoFocus={event => { if (!cart.length) { event.preventDefault(); (drinkGridRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? drinkGridRef.current)?.focus() } }}><DialogHeader><DialogTitle>The order.</DialogTitle><DialogDescription>Review the drinks and enter the guest’s first name before placing the order.</DialogDescription></DialogHeader>{summary}</DialogContent>
    </Dialog>}
  </section>{acceptedOrder && <aside className="order-summary"><p className="eyebrow">A little moment of joy</p><h2>The order.</h2>{summary}</aside>}</fieldset>
}
