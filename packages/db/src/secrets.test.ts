import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSecretBox } from './secrets'

const key = randomBytes(32).toString('base64')

describe('secret box', () => {
  it('round-trips and never produces the same ciphertext twice', () => {
    const box = createSecretBox(key)
    const a = box.seal('token-123')
    const b = box.seal('token-123')
    expect(a).not.toBe(b)
    expect(a).not.toContain('token-123')
    expect(box.open(a)).toBe('token-123')
  })
  it('rejects tampered data and a different key', () => {
    const box = createSecretBox(key)
    const sealed = box.seal('token-123')
    // Flip one bit of the first ciphertext byte — always a real change, unlike swapping a base64 char.
    const [version, iv, tag, data] = sealed.split(':') as [string, string, string, string]
    const bytes = Buffer.from(data, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0x01
    const tampered = [version, iv, tag, bytes.toString('base64')].join(':')
    expect(tampered).not.toBe(sealed)
    expect(() => box.open(tampered)).toThrow()
    expect(() => createSecretBox(randomBytes(32).toString('base64')).open(sealed)).toThrow()
  })
  it('refuses a key that is not 32 bytes', () => {
    expect(() => createSecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
