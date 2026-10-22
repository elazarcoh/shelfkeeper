import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const
const MAXMEM = 64 * 1024 * 1024
const KEY_LENGTH = 64

function scrypt(secret: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret.normalize('NFKC'), salt, keyLength, options, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

/** Format: scrypt$N$r$p$saltBase64$keyBase64 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(secret, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM })
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$')
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scrypt(secret, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

let dummy: Promise<string> | undefined
/** A real hash to verify against when the user does not exist, so timing does not reveal usernames. */
export function dummyHash(): Promise<string> {
  dummy ??= hashSecret('dummy-password-for-timing')
  return dummy
}
