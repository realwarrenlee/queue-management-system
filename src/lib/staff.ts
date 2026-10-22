import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { api } from './api'
import { StaffDB, flushPending, cacheSnapshot } from './offline'
import type { Pending } from './offline'
import { AppError } from '../../shared/domain'
import type { Role, Snapshot, Order } from '../../shared/domain'

export const staffDB = new StaffDB()
export function useStaff(role: Role | null, expired: () => void) {
  const snapshot = useLiveQuery(() => staffDB.cache.get('snapshot').then(row => row?.value), [])
  const pending = useLiveQuery(() => staffDB.pending.toArray(), []) ?? []
  const [connected, setConnected] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const sync = useCallback(async () => {
    if (!role || running.current) return
    running.current = true
    setSyncing(true)
    try {
      const send = async (row: Pending) => {
        try { return await api<Order>(row.kind === 'create' ? '/orders' : `/orders/${row.body.id}/status`, 'POST', row.body) }
        catch (error) { if (error instanceof AppError && error.status === 401) expired(); throw error }
      }
      if (navigator.locks) await navigator.locks.request('beans-sync', () => flushPending(staffDB, send))
      else await flushPending(staffDB, send)
      const fresh = await api<Snapshot>('/snapshot')
      await cacheSnapshot(staffDB, fresh)
      setConnected(true)
      setError('')
    } catch (error) {
      setConnected(false)
      if (error instanceof AppError && error.status === 401) expired()
      else setError('The counter is taking longer to respond. Your work is saved here; we’ll keep trying.')
    } finally { running.current = false; setSyncing(false) }
  }, [role, expired])
  useEffect(() => {
    if (!role) return
    void sync()
    const timer = setInterval(() => void sync(), 15_000)
    const offline = () => setConnected(false)
    window.addEventListener('online', sync)
    window.addEventListener('offline', offline)
    return () => { clearInterval(timer); window.removeEventListener('online', sync); window.removeEventListener('offline', offline) }
  }, [role, sync])
  return { snapshot, pending, connected, syncing, error, sync }
}
