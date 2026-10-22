import { resolve } from 'node:path'
import type { Config } from '@libsql/client'

export function databaseConfig(env: NodeJS.ProcessEnv = process.env): string | Config {
  const url = env.TURSO_DATABASE_URL?.trim()
  const authToken = env.TURSO_AUTH_TOKEN?.trim()
  if (env.TURSO_DATABASE_URL !== undefined || env.TURSO_AUTH_TOKEN !== undefined || env.RENDER === 'true' || env.VERCEL === '1') {
    if (!url || !authToken) throw new Error('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before starting with cloud storage.')
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('TURSO_DATABASE_URL must be a valid secure database URL.') }
    if (!['libsql:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use a secure libsql:// or https:// TURSO_DATABASE_URL without credentials or URL parameters.')
    return { url, authToken }
  }
  if (env.DB_PATH !== undefined && !env.DB_PATH.trim()) throw new Error('DB_PATH cannot be empty or blank.')
  return resolve(env.DB_PATH || 'data/beans.sqlite')
}
