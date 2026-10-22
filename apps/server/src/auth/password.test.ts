import { describe, expect, it } from 'vitest'
import { hashSecret, verifySecret } from './password'

describe('password hashing', () => {
  it('verifies the right secret only', async () => {
    const hash = await hashSecret('correct horse battery staple')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifySecret('correct horse battery staple', hash)).toBe(true)
    expect(await verifySecret('wrong', hash)).toBe(false)
  })
  it('salts every hash', async () => {
    expect(await hashSecret('1234')).not.toBe(await hashSecret('1234'))
  })
  it('rejects malformed stored hashes', async () => {
    expect(await verifySecret('x', 'not-a-hash')).toBe(false)
  })
})
