import { z } from 'zod'

export const progressStatuses = ['queued', 'making', 'ready', 'collected'] as const
export const statuses = [...progressStatuses, 'cancelled'] as const
export type Status = typeof statuses[number]
export const statusText: Record<Status, string> = { queued: 'Waiting', making: 'Making', ready: 'Ready to collect', collected: 'Collected', cancelled: 'Cancelled' }
export const milkOptions = [{ name: 'Dairy', extraCents: 0 }, { name: 'Oat', extraCents: 100 }, { name: 'Soy', extraCents: 80 }, { name: 'No milk', extraCents: 0 }]
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
export type Order = { id: string; number: number; firstName: string; lines: OrderLine[]; totalCents: number; status: Status; guestToken: string; createdAt: string; updatedAt: string; eventDay: string; revision: number; undoUntil?: string }
export type OrderChange = { action: 'advance' | 'undo' | 'correct' | 'cancel'; reason: string; role: Role; createdAt: string; previous: Order }
export type GuestOrder = Pick<Order, 'number' | 'firstName' | 'lines' | 'status' | 'updatedAt'> & { ordersAhead: number }
export type BoardOrder = Pick<Order, 'number' | 'firstName'>
export type Snapshot = { orders: Order[]; menu: MenuItem[]; serverTime: string }
export type Role = 'barista' | 'lead'
export type Report = { date: string; orders: number; cups: number; totalCents: number; drinks: { name: string; cups: number; totalCents: number }[] }
export const money = (cents: number) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(cents / 100)
export const ticket = (number: number) => String(number).padStart(3, '0')
export const singaporeDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
export class AppError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
