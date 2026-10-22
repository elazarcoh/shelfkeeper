import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface SecretBox {
  seal(plain: string): string
  open(sealed: string): string
}

/** The value can't be decrypted with this key (APP_SECRET_KEY changed, or the data was altered). */
export class SecretUnreadableError extends Error {
  override readonly name = 'SecretUnreadableError'
  constructor(options?: { cause?: unknown }) {
    super('Unreadable secret', options)
  }
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

/** AES-256-GCM with a random IV per value: "v1:<iv>:<tag>:<ciphertext>", all base64. */
export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('APP_SECRET_KEY must be 32 bytes, base64-encoded')
  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
    },
    open(sealed) {
      const [version, iv, tag, data] = sealed.split(':')
      if (version !== 'v1' || iv === undefined || tag === undefined || data === undefined) throw new SecretUnreadableError()
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'))
        decipher.setAuthTag(Buffer.from(tag, 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
      } catch (cause) {
        throw new SecretUnreadableError({ cause })
      }
    },
  }
}

/** For local development only — production refuses to start without APP_SECRET_KEY. */
export const DEV_SECRET_KEY = Buffer.from('dev-only-secret-key-do-not-use!!').toString('base64')
