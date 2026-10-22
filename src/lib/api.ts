import { AppError } from '../../shared/domain.ts'

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const result = await response.json()
  if (!response.ok) throw new AppError(result.error || 'Unable to connect. Please try again.', response.status)
  return result as T
}
