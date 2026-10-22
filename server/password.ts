// Adapted from OrderFlow src/auth.js (MIT); see THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto'

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$')
    if (scheme !== 'scrypt') return false
    const expected = Buffer.from(hashHex, 'hex')
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length)
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch { return false }
}
