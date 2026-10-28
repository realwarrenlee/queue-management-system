import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarDays, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { menuOptions, milkOptionsFor, money, singaporeDay } from '../../shared/domain'
import type { MenuItem, MenuOption, Report } from '../../shared/domain'
import { api } from '@/lib/api'

export function MenuControls({ menu, sync, connected }: { menu: MenuItem[]; sync: () => Promise<void>; connected: boolean }) {
  const [edit, setEdit] = useState<MenuOption | null>(null)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function open(item: MenuOption) { setEdit(item); setName(item.name); setPrice((item.priceCents / 100).toFixed(2)); setError('') }
  async function save(item: MenuOption, fields: Partial<Pick<MenuItem, 'name' | 'priceCents' | 'available'>>) {
    setBusy(true); setError('')
    try { await api(`/menu/${item.id}`, 'PATCH', fields); await sync(); setEdit(null) }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update this item.') }
    finally { setBusy(false) }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!edit) return
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(price)) { setError('Enter a price with up to two decimal places.'); return }
    const priceCents = Math.round(Number(price) * 100) - edit.extraCents
    if (priceCents < 0) { setError(`Enter a price of at least ${money(edit.extraCents)}.`); return }
    void save(edit, { name, priceCents })
  }
  return <section className="lead-page"><div className="page-heading"><h1>Today’s good things.</h1><p className="page-subtitle">Keep the counter and the menu in harmony.</p></div>
    {!connected && <p className="notice">Reconnect before changing the shared menu.</p>}{error && !edit && <p className="error" role="alert">{error}</p>}
    <Table className="staff-table menu-table"><TableHeader><TableRow><TableHead>Drink</TableHead><TableHead className="numeric">Price</TableHead><TableHead>Available</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{menuOptions(menu).map(item => <TableRow key={`${item.id}-${item.milk}`}><TableCell><strong>{item.label}</strong></TableCell><TableCell className="numeric">{money(item.priceCents)}</TableCell><TableCell><div className="availability"><Switch checked={item.available} disabled={busy || !connected} aria-label={`${item.label} available`} onCheckedChange={available => void save(item, { available })} /><span>{item.available ? 'On the menu' : 'Sold out'}</span></div></TableCell><TableCell className="text-right"><Button className="table-action" variant="outline" disabled={busy || !connected} aria-label={`Edit ${item.label}`} onClick={() => open(item)}>Edit</Button></TableCell></TableRow>)}</TableBody></Table>
    <p className="section-note">Oat versions share the drink’s name and availability and cost S$1 more. Iced adds S$1 per cup. Existing orders keep their accepted prices.</p>
    <Dialog open={!!edit} onOpenChange={value => { if (!value) setEdit(null) }}><DialogContent><DialogHeader><DialogTitle>Edit {edit?.label}</DialogTitle><DialogDescription>{edit && milkOptionsFor(edit.id).length ? 'Changes apply to both regular and oat versions; prices stay S$1 apart.' : 'Changes apply to new orders after they sync.'}</DialogDescription></DialogHeader><form className="form-stack" onSubmit={submit}><Label htmlFor="menu-name">Drink name</Label><Input id="menu-name" value={name} maxLength={60} onChange={event => setName(event.target.value)} required /><Label htmlFor="menu-price">Price (SGD)</Label><Input id="menu-price" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} required />{error && <p className="error" role="alert">{error}</p>}<Button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save changes'}</Button></form></DialogContent></Dialog>
  </section>
}

export function Reports({ revision }: { revision: string }) {
  const [day, setDay] = useState(singaporeDay())
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const selectedDate = new Date(`${day}T00:00:00+08:00`)
  const dateLabel = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' }).format(selectedDate)
  useEffect(() => {
    let active = true
    setReport(previous => previous?.date === day ? previous : null)
    setError('')
    if (day) api<Report>(`/reports/${day}`).then(value => { if (active) { setReport(value); setUpdated(new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' })) } }).catch(() => { if (active) setError('Unable to refresh. Showing the last loaded totals; reconnect to update them.') })
    return () => { active = false }
  }, [day, revision])
  return <section className="lead-page"><div className="page-heading heading-with-action"><div><h1>Every cup counts.</h1><p className="page-subtitle">A day of coffee, a little more good.</p></div><div className="report-actions">
    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
      <PopoverTrigger asChild><Button id="report-day" className="report-date" variant="outline" aria-label={`Report date in Singapore: ${dateLabel}`}>{dateLabel}<CalendarDays /></Button></PopoverTrigger>
      <PopoverContent className="report-calendar-popover w-auto p-0" align="start" aria-label="Choose report date">
        <Calendar className="report-calendar" mode="single" required selected={selectedDate} defaultMonth={selectedDate} timeZone="Asia/Singapore" onSelect={date => { setDay(singaporeDay(date)); setCalendarOpen(false) }} autoFocus />
      </PopoverContent>
    </Popover>
    <Button asChild variant="outline" disabled={!report}><a href={report ? `/api/reports/${day}/csv` : undefined} aria-disabled={!report}><Download />Export CSV</a></Button></div></div>
  <p className="notice">Recorded value excludes cancelled and pending orders. Payments and refunds are handled separately on the organiser’s POS; this report is not reconciled sales. CSV includes cancelled rows for review.</p>
  {error && <p className="error" role="alert">Report unavailable. {error}</p>}{report && <><div className="report-metrics"><div><span>Cups made possible</span><strong>{report.cups}</strong></div><div><span>Orders recorded</span><strong>{report.orders}</strong></div><div><span>Recorded value</span><strong>{money(report.totalCents)}</strong></div></div><Table className="staff-table report-table"><TableHeader><TableRow><TableHead>Drink</TableHead><TableHead className="numeric">Cups</TableHead><TableHead className="numeric">Recorded value</TableHead></TableRow></TableHeader><TableBody>{report.drinks.map(row => <TableRow key={row.name}><TableCell><strong>{row.name}</strong></TableCell><TableCell className="numeric">{row.cups}</TableCell><TableCell className="numeric">{money(row.totalCents)}</TableCell></TableRow>)}</TableBody></Table>{!report.orders && <p className="section-note">No confirmed orders were recorded on this date.</p>}{report.date === day && <p className="section-note">Updates with counter sync · Last updated {updated}</p>}</>}
  </section>
}
