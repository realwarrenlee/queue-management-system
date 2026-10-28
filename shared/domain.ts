import { z } from 'zod'

export const progressStatuses = ['queued', 'making', 'ready', 'collected'] as const
export const statuses = [...progressStatuses, 'cancelled'] as const
export type Status = typeof statuses[number]
export const statusText: Record<Status, string> = { queued: 'Waiting', making: 'Making', ready: 'Ready to collect', collected: 'Collected', cancelled: 'Cancelled' }
export const milkOptions = [{ name: 'Dairy', label: 'Regular milk', extraCents: 0 }, { name: 'Oat', label: 'Oat milk', extraCents: 100 }] as const
export const milkOptionsFor = (menuId: string) => ['latte', 'flat-white'].includes(menuId) ? milkOptions : []
export const milkText = { Dairy: 'Regular milk', Oat: 'Oat milk', Soy: 'Soy milk', 'No milk': 'No milk' }
export const icedExtraCents = 100
export const temperatures = ['Hot', 'Iced'] as const
export const lineSchema = z.object({
  menuId: z.string().min(1).max(80), milk: z.enum(['Dairy', 'Oat', 'Soy', 'No milk']),
  temperature: z.enum(temperatures), quantity: z.number().int().min(1).max(20),
  expectedUnitCents: z.number().int().min(0).optional(),
})
export const draftSchema = z.object({
  id: z.uuid(),
  firstName: z.string().trim().min(1, 'Enter a first name').max(40).refine(value => !/[\p{Cc}]/u.test(value), 'Use a printable first name'),
  lines: z.array(lineSchema).min(1).max(20),
})
export const menuSchema = z.object({ name: z.string().trim().min(1).max(60), priceCents: z.number().int().min(0).max(50000), available: z.boolean() })
export const revisionSchema = z.number().int().min(0)
export const changeSchema = z.object({ revision: revisionSchema, reason: z.string().trim().min(1, 'Enter a reason for this change.').max(200).refine(value => !/[\p{Cc}]/u.test(value), 'Use a printable reason.') })
export const correctionSchema = draftSchema.omit({ id: true }).extend(changeSchema.shape)
export type Draft = z.infer<typeof draftSchema>
export type MenuItem = { id: string; name: string; priceCents: number; available: boolean; category: string; description: string }
export type OrderLine = Draft['lines'][number] & { name: string; unitCents: number }
export function drinkLabel(line: Pick<OrderLine, 'menuId' | 'name' | 'milk'>) {
  if (line.milk === 'Dairy' && milkOptionsFor(line.menuId).length) return line.name
  if (line.milk === 'No milk' && ['espresso', 'americano', 'pourover', 'black'].includes(line.menuId)) return line.name
  return `${line.name} (${milkText[line.milk].toLowerCase()})`
}
export function menuOptions(menu: MenuItem[]) {
  return menu.flatMap(item => {
    const options = milkOptionsFor(item.id)
    return (options.length ? options : [{ name: 'No milk' as const, extraCents: 0 }]).map(option => ({
      ...item, milk: option.name, extraCents: option.extraCents, priceCents: item.priceCents + option.extraCents,
      label: drinkLabel({ menuId: item.id, name: item.name, milk: option.name }),
    }))
  })
}
export type MenuOption = ReturnType<typeof menuOptions>[number]
export const unitPriceCents = (item: MenuItem, line: Pick<OrderLine, 'milk' | 'temperature'>) => item.priceCents + (milkOptions.find(option => option.name === line.milk)?.extraCents ?? 0) + (line.temperature === 'Iced' ? icedExtraCents : 0)
export type Order = { id: string; number: number; firstName: string; lines: OrderLine[]; totalCents: number; status: Status; guestToken: string; createdAt: string; updatedAt: string; eventDay: string; revision: number; undoUntil?: string }
export type OrderChange = { action: 'advance' | 'undo' | 'correct' | 'cancel'; reason: string; role: Role; createdAt: string; previous: Order }
export type GuestOrder = Pick<Order, 'number' | 'firstName' | 'lines' | 'status' | 'updatedAt'> & { ordersAhead: number }
export type BoardOrder = Pick<Order, 'number' | 'firstName'>
export type Snapshot = { orders: Order[]; menu: MenuItem[]; serverTime: string; sourceId?: string }
export type Role = 'barista' | 'lead'
export type Report = { date: string; orders: number; cups: number; totalCents: number; drinks: { name: string; cups: number; totalCents: number }[] }
export const money = (cents: number) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(cents / 100)
export const ticket = (number: number) => String(number).padStart(3, '0')
export const singaporeDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
export class AppError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
