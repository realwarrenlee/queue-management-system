import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { ExternalLink, Copy, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ticket } from '../../shared/domain'
import type { Order } from '../../shared/domain'

export function Handoff({ order, close }: { order: Order | null; close: () => void }) {
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const url = order ? `${location.origin}/g/${order.guestToken}` : ''
  useEffect(() => {
    let active = true
    setCopied(false); setQr(''); setError('')
    if (url) QRCode.toDataURL(url, { width: 260, margin: 2, color: { dark: '#124c3b', light: '#fffdf9' } }).then(value => { if (active) setQr(value) }).catch(() => setError('QR unavailable. Open or copy the order link below.'))
    return () => { active = false }
  }, [url])
  return <Dialog open={!!order} onOpenChange={open => { if (!open) close() }}><DialogContent className="handoff-dialog"><DialogHeader>
    <DialogTitle>One good coffee, on its way.</DialogTitle><DialogDescription>Ask {order?.firstName} to scan this code to follow their order.</DialogDescription>
  </DialogHeader><div className="handoff-number">{order && ticket(order.number)}</div>{qr && <img className="handoff-qr" src={qr} alt={`Private tracking QR code for order ${order?.number}`} />}
  {error && <p role="alert">{error}</p>}
  <p className="quiet text-center">This link shows only this order. Keep it private.</p>
  {location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? <p className="notice">Local preview: this QR address opens on this computer only. Phone testing needs a reachable HTTPS address.</p> : null}
  <div className="button-row"><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true) } catch { setError('Copy is unavailable. Open the link and copy its address.') } }}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</Button><Button asChild variant="outline"><a href={url} target="_blank" rel="noreferrer">View order <ExternalLink /></a></Button></div>
  </DialogContent></Dialog>
}
