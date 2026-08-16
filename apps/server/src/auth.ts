import { randomBytes, randomUUID, scrypt, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { DB } from './db.ts'

const derive = promisify(scrypt) as (p: string, s: Buffer, len: number) => Promise<Buffer>

/**
 * Who is allowed in.
 *
 * Passwords are scrypt-hashed: memory-hard, in the standard library, and the
 * only thing here that has to survive a stolen database file.
 *
 * There is a second, uncomfortable half. **Subsonic clients cannot
 * authenticate against a hash.** Their scheme is `token = md5(password + salt)`
 * with a salt the *client* chooses, so verifying it requires the server to hold
 * the password in recoverable form. Navidrome and every other Subsonic server
 * face the same wall and make the same choice: keep an encrypted copy.
 *
 * So that copy is optional and separate. A user who never opens a Subsonic app
 * has only the hash, and turning it on is a decision with a stated cost rather
 * than a silent default.
 */

const KEYLEN = 64

export type User = {
  id: string
  username: string
  role: 'admin' | 'user'
  /** Whether a recoverable password is stored for Subsonic clients. */
  subsonic: 0 | 1
  createdAt: number
  lastSeenAt: number | null
}

export type Token = {
  id: string
  userId: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

const hydrate = (r: any): User => ({
  id: r.id, username: r.username, role: r.role,
  subsonic: r.subsonicSecret ? 1 : 0,
  createdAt: r.createdAt, lastSeenAt: r.lastSeenAt,
})

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, KEYLEN)
  // Salt and hash together: one column, and no way to pair the wrong two.
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length)
  // Constant time: a plain === leaks how much of the hash matched, one byte at
  // a time, which is enough to reconstruct it given enough attempts.
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * The key protecting recoverable passwords.
 *
 * From `JUKEBOX_SECRET` when set. Otherwise derived from the database's own
 * path so a single-user install works without configuration — which is worth
 * being plain about: it protects a stolen database file, not a stolen machine.
 */
function secretKey(dbFile: string): Buffer {
  const material = process.env.JUKEBOX_SECRET || `jukebox:${dbFile}`
  return createHash('sha256').update(material).digest()
}

export function encryptSecret(plain: string, dbFile: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretKey(dbFile), iv)
  const out = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), out.toString('base64')].join('$')
}

export function decryptSecret(stored: string, dbFile: string): string | null {
  try {
    const [iv, tag, body] = stored.split('$')
    const decipher = createDecipheriv('aes-256-gcm', secretKey(dbFile), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // A wrong key or a tampered value. Not distinguishable, and should not be.
    return null
  }
}

export function listUsers(db: DB): User[] {
  return (db.prepare(`SELECT * FROM users ORDER BY username`).all() as any[]).map(hydrate)
}

export function getUser(db: DB, id: string): User | null {
  const r = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as any
  return r ? hydrate(r) : null
}

export async function createUser(
  db: DB,
  input: { username: string; password: string; role?: 'admin' | 'user'; subsonic?: boolean },
  dbFile: string,
): Promise<User> {
  const id = `u-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO users (id, username, passwordHash, role, subsonicSecret, createdAt)
              VALUES (?,?,?,?,?,?)`)
    .run(id, input.username, await hashPassword(input.password), input.role ?? 'user',
      input.subsonic ? encryptSecret(input.password, dbFile) : null, Date.now())
  return getUser(db, id)!
}

/** Username and password. Returns `null` for both "no such user" and "wrong password". */
export async function authenticate(db: DB, username: string, password: string): Promise<User | null> {
  const r = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as any
  if (!r) {
    // Hash anyway. Returning early on an unknown username makes the response
    // time say whether the account exists.
    await hashPassword(password)
    return null
  }
  if (!(await verifyPassword(password, r.passwordHash))) return null
  db.prepare(`UPDATE users SET lastSeenAt = ? WHERE id = ?`).run(Date.now(), r.id)
  return hydrate(r)
}

/**
 * A bearer token.
 *
 * Returned once, at creation, and only its hash is kept — the same reason
 * passwords are not stored. A token that can be read back out of the database
 * is a password with a longer name.
 */
export function createToken(db: DB, userId: string, name: string): { token: string; id: string } {
  const secret = randomBytes(24).toString('base64url')
  const id = `tk-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO tokens (id, userId, name, hash, createdAt) VALUES (?,?,?,?,?)`)
    .run(id, userId, name, createHash('sha256').update(secret).digest('hex'), Date.now())
  // The id travels with it so a lost token can still be revoked by name.
  return { token: `${id}.${secret}`, id }
}

export function userForToken(db: DB, token: string): User | null {
  const cut = token.indexOf('.')
  if (cut < 1) return null
  const [id, secret] = [token.slice(0, cut), token.slice(cut + 1)]
  const row = db.prepare(`SELECT * FROM tokens WHERE id = ?`).get(id) as any
  if (!row) return null

  const given = createHash('sha256').update(secret).digest()
  const stored = Buffer.from(row.hash, 'hex')
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null

  db.prepare(`UPDATE tokens SET lastUsedAt = ? WHERE id = ?`).run(Date.now(), id)
  return getUser(db, row.userId)
}

export const listTokens = (db: DB, userId: string): Token[] =>
  db.prepare(`SELECT id, userId, name, createdAt, lastUsedAt FROM tokens WHERE userId = ? ORDER BY createdAt DESC`)
    .all(userId) as Token[]

export const revokeToken = (db: DB, id: string): boolean =>
  (db.prepare(`DELETE FROM tokens WHERE id = ?`).run(id).changes as number) > 0

/**
 * Verifies a Subsonic client's `t` and `s` parameters.
 *
 * `t = md5(password + salt)`, salt chosen by the client. Only possible against
 * a recoverable password, which is why `subsonicSecret` exists and why it is
 * opt-in.
 */
export function verifySubsonic(db: DB, username: string, token: string, salt: string, dbFile: string): User | null {
  const r = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as any
  if (!r?.subsonicSecret) return null
  const password = decryptSecret(r.subsonicSecret, dbFile)
  if (password === null) return null

  const expected = createHash('md5').update(password + salt).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(token.toLowerCase(), 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return hydrate(r)
}

/** True when nobody has been created yet — the state a fresh install boots into. */
export const isOpen = (db: DB): boolean =>
  (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n === 0
