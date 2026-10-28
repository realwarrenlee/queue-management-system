import { useEffect, useRef, useState } from 'react'
import { Coffee, Volume2, Check, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog'
import { Brand } from '@/components/brand'
import { api } from '@/lib/api'
import { drinkLabel, ticket } from '../../shared/domain'
import type { BoardOrder, GuestOrder, Status } from '../../shared/domain'

const guestArtDescriptions: Record<Status, string> = {
  queued: 'Our barista holding your order ticket while it waits its turn',
  making: 'Our barista carefully preparing your coffee',
  ready: 'Our barista offering your finished coffee for collection',
  collected: 'Our barista waving goodbye after you collect your coffee',
  cancelled: 'Your order has been cancelled. Please speak to the counter for help.',
}

function usePublic<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  useEffect(() => {
    let active = true
    let running = false
    const load = async () => {
      if (running) return
      running = true
      try { const result = await api<T>(path); if (active) { setData(result); setError(''); setUpdated(new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' })) } }
      catch (error) { if (active) setError(error instanceof Error ? error.message : 'Unable to refresh.') }
      finally { running = false }
    }
    void load()
    const timer = setInterval(load, 3000)
    window.addEventListener('online', load)
    return () => { active = false; clearInterval(timer); window.removeEventListener('online', load) }
  }, [path])
  return { data, error, updated }
}

export function GuestPage({ token }: { token: string }) {
  const { data: order, error, updated } = usePublic<GuestOrder>(`/guest/${encodeURIComponent(token)}`)
  const [sound, setSound] = useState(false)
  const [soundError, setSoundError] = useState('')
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const privacyTitleRef = useRef<HTMLHeadingElement>(null)
  const context = useRef<AudioContext | null>(null)
  const previous = useRef<Status | null>(null)
  useEffect(() => {
    if (!order) return
    document.title = order.status === 'ready' ? `Order ${ticket(order.number)} is ready! · beans&beats` : `Order ${ticket(order.number)} · beans&beats`
    if (order.status === 'ready' && previous.current && previous.current !== 'ready' && sound && context.current) {
      const audio = context.current
      void audio.resume().then(() => {
        const oscillator = audio.createOscillator()
        const gain = audio.createGain()
        oscillator.connect(gain); gain.connect(audio.destination)
        oscillator.frequency.setValueAtTime(660, audio.currentTime)
        oscillator.frequency.setValueAtTime(880, audio.currentTime + .18)
        gain.gain.setValueAtTime(.12, audio.currentTime)
        gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .6)
        oscillator.start(); oscillator.stop(audio.currentTime + .6)
      }).catch(() => setSoundError('Sound could not play. Your status will still update here.'))
    }
    previous.current = order.status
  }, [order, sound])
  useEffect(() => () => { void context.current?.close() }, [])
  async function enableSound() {
    try { context.current ??= new AudioContext(); await context.current.resume(); setSound(true) }
    catch { setSoundError('This browser could not enable sound. Watch this page for updates.') }
  }
  const drink = order?.lines.length === 1 ? order.lines[0].name.toLowerCase() : 'coffee'
  const headline = !order ? '' : order.status === 'queued' ? 'you’re in the queue.' : order.status === 'making' ? `we’re making your ${drink}.` : order.status === 'ready' ? `your ${drink}’s ready.` : order.status === 'cancelled' ? 'your order is cancelled.' : 'enjoy every sip.'
  return <div className="guest-shell"><main className="guest-paper"><header><Brand /></header>{order ? <>
    {error && <p className="notice" role="status">Updates paused. Showing the last known status ({updated} SGT). Please check the booth board while we reconnect.</p>}
    <h1 className="guest-headline" aria-live="polite">{order.firstName},<br />{headline}</h1>
    <div role="img" aria-label={guestArtDescriptions[order.status]} className={`barista-art art-${order.status}`} />
    <p className="guest-order-number">Order {ticket(order.number)}</p>
    <div className="guest-drinks">{order.lines.map((line, index) => <div key={index}><strong>{line.quantity} × {line.temperature === 'Iced' ? 'Iced ' : ''}{drinkLabel(line).toLowerCase()}</strong></div>)}</div>
    <div className="guest-instructions">{order.status === 'ready' ? <><strong>Collect at the beans&beats counter.</strong><p>Show order {ticket(order.number)} when you arrive.</p></> : order.status === 'collected' ? <><strong>Collected with a little love.</strong><p>Thank you for supporting Young Hearts.</p></> : order.status === 'cancelled' ? <><strong>Please check with the counter.</strong><p>Quote order {ticket(order.number)} for help. Any payment adjustment is handled at the counter.</p></> : <>
      <p>{order.status === 'queued' ? order.ordersAhead ? `${order.ordersAhead} ${order.ordersAhead === 1 ? 'earlier order is' : 'earlier orders are'} waiting or being made. Preparation times vary.` : 'Your order is next in the waiting queue. Preparation times vary.' : 'We’re preparing your order. This page will update when it’s ready.'}</p>
      <Button className="sound-button" variant="outline" onClick={() => { if (sound) setSound(false); else void enableSound() }}>{sound ? <Check /> : <Volume2 />}{sound ? 'Turn page sound off' : 'Enable page sound'}</Button>
      <p className="field-note">Keep this page open and your phone awake for sound. Alerts aren’t sent when you close it or lock your phone. You can also check the booth display.</p>
      {soundError && <p className="notice" role="status">{soundError}</p>}
    </>}</div>
  </> : <div className="public-loading"><Coffee size={40} strokeWidth={1.2} /><h1>{error ? 'Let’s find your coffee.' : 'Finding your order…'}</h1><p role="status">{error || 'Just a moment.'}</p>{error && <p>Ask the counter to show your order’s QR code again.</p>}</div>}
  <footer className="guest-footer"><Dialog open={privacyOpen} onOpenChange={setPrivacyOpen}>
    <DialogTrigger asChild><a href="#privacy-notice" onClick={event => { event.preventDefault(); setPrivacyOpen(true) }}>Privacy notice</a></DialogTrigger>
    <DialogContent className="privacy-notice" onOpenAutoFocus={event => { event.preventDefault(); privacyTitleRef.current?.focus() }}><DialogHeader>
      <DialogTitle ref={privacyTitleRef} tabIndex={-1} className="outline-none">Privacy notice</DialogTitle>
      <DialogDescription>beans&beats uses your first name and order details to prepare your drinks, show order progress and manage pickup.</DialogDescription>
    </DialogHeader>
      <p>When your order is ready, your first name and ticket number appear on the booth’s public ready board. Anyone with your order link can view your order, so keep the link private.</p>
      <p>Order records are stored on our server and staff devices, including offline copies used for syncing. This app does not collect your phone number. Payments are handled separately on the organiser’s POS.</p>
      <p>For questions about access, correction, retention or deletion of your information, please speak to the booth lead at the beans&beats counter.</p>
    </DialogContent>
  </Dialog></footer></main></div>
}

export function ReadyBoard() {
  const { data: orders, error, updated } = usePublic<BoardOrder[]>('/board')
  return <div className="board-shell"><header className="board-header"><Brand showEvent={false} /></header><main><div className="board-title"><div><p className="eyebrow">A little good, ready to go</p><h1>Good coffee.<br /><em>Yours to collect.</em></h1></div></div>
  {error && <p className="notice" role="status">This board may be out of date. Last refreshed {updated || 'not yet'}{updated ? ' SGT' : ''}. Please ask the barista.</p>}
  <div className="board-orders" aria-live="polite">{orders?.map(order => <div className="board-order" key={order.number}><span>{ticket(order.number)}</span><strong>{order.firstName}</strong><ArrowUpRight aria-hidden="true" size={28} /></div>)}</div>{orders?.length === 0 && <div className="board-empty"><Coffee size={56} strokeWidth={1} /><p>We’re brewing a little happiness.</p><span>Your name and number will appear when your order is ready.</span></div>}
  <p className="board-help">See your number? Come say hello at the counter.</p></main></div>
}
