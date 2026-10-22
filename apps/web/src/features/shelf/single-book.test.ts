import { describe, expect, it } from 'vitest'
import type { ShelfStatus } from '@mylib/domain'
import { addDisabled, addLabel, addTarget, existingWishDraft, pickMaybe, wishlistBlocked, wishTarget } from './single-book'

const work = 'a1111111-1111-4111-8111-111111111111'

describe('single-book add', () => {
  it('says what the add does for each status', () => {
    expect(addLabel({ kind: 'have', workId: work, title: 'X' }, 'owned')).toBe('Add a second copy of X')
    expect(addLabel({ kind: 'copy_of', workId: work, title: 'X' }, 'owned')).toBe('Add as physical copy of X')
    expect(addLabel({ kind: 'maybe', workId: work, title: 'X' }, 'owned')).toBe('Add as a new book')
    expect(addLabel({ kind: 'in_inbox', proposalId: work, title: 'X' }, 'owned')).toBe('Add anyway')
    expect(addLabel({ kind: 'new' }, 'owned')).toBe('Add to library')
  })
  it('says what the add does when the book goes on the wishlist', () => {
    expect(addLabel({ kind: 'new' }, 'wishlist')).toBe('Add to my wishlist')
    expect(addLabel({ kind: 'have', workId: work, title: 'X' }, 'wishlist')).toBe('Add to my wishlist')
    expect(addLabel({ kind: 'have', workId: work, title: 'X' }, 'wishlist', true)).toBe('Update my wish')
    expect(addLabel({ kind: 'new' }, 'owned')).toBe('Add to library')
  })
  it('a wish goes on the matched book, or makes a new one', () => {
    expect(wishTarget({ kind: 'have', workId: work, title: 'X' })).toEqual({ action: 'wish_work', workId: work })
    expect(wishTarget({ kind: 'copy_of', workId: work, title: 'X' })).toEqual({ action: 'wish_work', workId: work })
    expect(wishTarget({ kind: 'maybe', workId: work, title: 'X' })).toEqual({ action: 'create_work' })
    expect(wishTarget({ kind: 'new' })).toEqual({ action: 'create_work' })
  })
  it('"It\'s this book" turns a maybe into a copy of that book, and leaves anything else alone', () => {
    expect(pickMaybe({ kind: 'maybe', workId: work, title: 'X' })).toEqual({ kind: 'copy_of', workId: work, title: 'X' })
    expect(pickMaybe({ kind: 'new' })).toEqual({ kind: 'new' })
    expect(pickMaybe(null)).toBeNull()
  })
})

describe('single-book wishlist guards', () => {
  const mine = [{ workId: work, formats: ['physical' as const], language: 'he', note: 'the new translation' }]
  it('seeds the form from my existing wish on the matched book, so updating never blanks it', () => {
    expect(existingWishDraft(mine, work)).toEqual({ formats: ['physical'], language: 'he', note: 'the new translation' })
  })
  it('has nothing to seed with when there is no match, no wish on it, or the list is still loading', () => {
    expect(existingWishDraft(mine, null)).toBeNull()
    expect(existingWishDraft(mine, 'b2222222-2222-4222-8222-222222222222')).toBeNull()
    expect(existingWishDraft(undefined, work)).toBeNull()
  })
  const have = { kind: 'have' as const, workId: work, title: 'X' }
  it('keeps the add disabled in Wishlist mode until my wishes have loaded', () => {
    expect(addDisabled({ adding: false, status: have, ownership: 'wishlist', wishesLoaded: false })).toBe(true)
    expect(addDisabled({ adding: false, status: have, ownership: 'wishlist', wishesLoaded: true })).toBe(false)
    expect(addDisabled({ adding: false, status: have, ownership: 'owned', wishesLoaded: false })).toBe(false)
  })
  it('keeps the add disabled while adding or before the status is known', () => {
    expect(addDisabled({ adding: true, status: have, ownership: 'owned', wishesLoaded: true })).toBe(true)
    expect(addDisabled({ adding: false, status: null, ownership: 'owned', wishesLoaded: true })).toBe(true)
  })
  it('does not offer a wish on a book already waiting in the Inbox', () => {
    const inbox = { kind: 'in_inbox' as const, proposalId: work, title: 'X' }
    expect(wishlistBlocked(inbox)).toBe(true)
    expect(wishlistBlocked({ kind: 'new' })).toBe(false)
    expect(wishlistBlocked(null)).toBe(false)
    expect(addDisabled({ adding: false, status: inbox, ownership: 'wishlist', wishesLoaded: true })).toBe(true)
  })
})

describe('new volume', () => {
  const nv: ShelfStatus = { kind: 'new_volume', workId: work, title: 'דרך המלכים', volume: { number: 2, have: [1], size: 2 } }
  it('says what the add does, and files it on that book', () => {
    expect(addLabel(nv, 'owned')).toBe('Add as volume 2 of דרך המלכים')
    expect(wishTarget(nv)).toEqual({ action: 'wish_work', workId: work })
    expect(addTarget(nv)).toEqual({ action: 'link_new_edition', workId: work })
  })
  it('a new book is created', () => {
    expect(addTarget({ kind: 'new' })).toEqual({ action: 'create_work' })
    expect(addTarget(null)).toEqual({ action: 'create_work' })
    expect(addTarget({ kind: 'have', workId: work, title: 'X' })).toEqual({ action: 'link_new_edition', workId: work })
  })
})
