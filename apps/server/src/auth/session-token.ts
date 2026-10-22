import { createHash, randomBytes } from 'node:crypto'

export const newSessionToken = (): string => randomBytes(32).toString('base64url')
export const sessionIdFromToken = (token: string): string => createHash('sha256').update(token).digest('hex')
