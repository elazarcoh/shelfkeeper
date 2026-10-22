import { describe, expect, it } from 'vitest'
import { accountStatusLine, pastReadsLine, pushSummary, ratingLine } from './status-line'

describe('hardcover status lines', () => {
  it('names the account and what is wrong', () => {
    expect(accountStatusLine(null)).toBe('Not connected')
    expect(accountStatusLine({ status: 'ok', statusDetail: null, username: 'home' })).toBe('Connected as @home')
    expect(accountStatusLine({ status: 'needs_token', statusDetail: 'Hardcover rejected the token', username: 'home' })).toBe('Needs a new token (Hardcover rejected the token)')
    expect(accountStatusLine({ status: 'missing_scope', statusDetail: 'read:vibes', username: 'home' })).toBe('Missing permission: read:vibes')
  })
  it('rounds the rating to one decimal and groups the count', () => {
    expect(ratingLine(4.256, 1234)).toBe('★ 4.3 (1,234 ratings)')
    expect(ratingLine(4, 1)).toBe('★ 4.0 (1 rating)')
    expect(ratingLine(null, 0)).toBeNull()
  })
  it('sums up sends, leaving out empty statuses (#140)', () => {
    expect(pushSummary({ waiting: 0, sent: 0, skipped: 0 })).toBeNull()
    expect(pushSummary({ waiting: 3, sent: 1200, skipped: 0 })).toBe('3 waiting · 1,200 sent')
  })
  it('says how many past reads go and how many wait for a match (#140)', () => {
    expect(pastReadsLine(1, 1)).toBe('1 book you finished and haven’t sent yet will be marked Read on Hardcover, with your rating. Books already Read there are skipped, nothing there is changed or deleted, and they go out a batch an hour.')
    expect(pastReadsLine(5, 3)).toContain('2 books not yet matched on Hardcover will wait until they are.')
    expect(pastReadsLine(2, 1)).toContain('1 book not yet matched on Hardcover will wait until it is.')
  })
})
