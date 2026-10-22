import { describe, expect, it } from 'vitest'
import { hideWorkFromUser, loadUserScope, setRating } from '@mylib/db'
import { COVER_PNG } from '@mylib/connectors/testing'
import { COVER_URL_TEST, useServerHarness } from '../testing/harness'

const dune = {
  title: 'Dune',
  authors: ['Frank Herbert'],
  editions: [{ format: 'physical' as const, isbn13: '978-0-441-17271-9' }],
}

describe('catalog & library routers', () => {
  const h = useServerHarness()

  it('creates a book into My books and reads it back', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: dune })
    const book = await api.catalog.get({ workId })
    expect(book.editions[0]?.isbn13).toBe('9780441172719')
    expect(book.sets.map((s) => s.name)).toEqual(['My books'])
    const lib = await api.library.list({})
    expect(lib.items.map((i) => i.title)).toEqual(['Dune'])
  })

  it('can create a book without adding it to My books', async () => {
    const { api } = await h.asNewUser()
    await api.catalog.create({ work: dune, addToMyBooks: false })
    expect((await api.library.list({})).total).toBe(0)
    expect((await api.library.list({ scope: 'catalog' })).total).toBe(1)
  })

  it('adds an edition into My books only when asked', async () => {
    const creator = await h.asNewUser()
    const { workId } = await creator.api.catalog.create({ work: dune, addToMyBooks: false })
    const { api } = await h.asNewUser()
    await api.catalog.addEdition({ workId, edition: { format: 'ebook' } })
    expect((await api.library.list({})).total).toBe(0)
    await api.catalog.addEdition({ workId, edition: { format: 'audiobook' }, addToMyBooks: true })
    expect((await api.library.list({})).items.map((i) => i.title)).toEqual(['Dune'])
  })

  it('validates input at the boundary', async () => {
    const { api } = await h.asNewUser()
    await expect(
      api.catalog.create({ work: { ...dune, editions: [{ format: 'physical', isbn13: '9780441172710' }] } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(api.catalog.get({ workId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('edits, adds and splits editions', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: dune })
    await api.catalog.update({ workId, patch: { subtitle: 'Book One' } })
    const { editionId } = await api.catalog.addEdition({ workId, edition: { format: 'audiobook', durationSec: 75_600 } })
    const split = await api.catalog.splitEdition({ editionId })
    expect((await api.catalog.get({ workId })).subtitle).toBe('Book One')
    expect((await api.catalog.get({ workId: split.workId })).editions.map((e) => e.format)).toEqual(['audiobook'])
    await expect(api.catalog.deleteEdition({ editionId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lets an admin merge books into one, and refuses members and bad input', async () => {
    const admin = await h.asNewUser('admin')
    const target = await admin.api.catalog.create({ work: dune })
    const source = await admin.api.catalog.create({ work: { ...dune, editions: [{ format: 'ebook' }] } })

    const member = await h.asNewUser()
    await expect(member.api.catalog.mergeWorks({ targetWorkId: target.workId, sourceWorkIds: [source.workId] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(admin.api.catalog.mergeWorks({ targetWorkId: target.workId, sourceWorkIds: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(admin.api.catalog.mergeWorks({ targetWorkId: target.workId, sourceWorkIds: [target.workId] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(admin.api.catalog.mergeWorks({ targetWorkId: target.workId, sourceWorkIds: ['not-a-uuid'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    const merged = await admin.api.catalog.mergeWorks({ targetWorkId: target.workId, sourceWorkIds: [source.workId] })
    expect(merged).toEqual({ workId: target.workId, dropped: [] })
    expect((await admin.api.catalog.get({ workId: target.workId })).editions.map((e) => e.format).sort()).toEqual(['ebook', 'physical'])
    await expect(admin.api.catalog.get({ workId: source.workId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('keeps a book I no longer have in my library, marked formerly owned', async () => {
    const { user, api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: dune })
    await setRating(h.db, await loadUserScope(h.db, user), workId, 4) // tracking router arrives in Task 12
    const editionId = (await api.catalog.get({ workId })).editions[0]?.id ?? ''
    await api.catalog.changeHolding({ editionId, change: { action: 'no_longer_have', on: '2026-01-01', note: 'Gave it to a friend' } })

    const book = await api.catalog.get({ workId })
    expect(book.availability).toBe('formerly_owned')
    expect(book.me.rating).toBe(4)
    expect((await api.library.list({})).items.map((i) => [i.title, i.availability])).toEqual([['Dune', 'formerly_owned']])
    const haveNow = await api.library.list({ filter: { op: 'availability', values: ['owned', 'borrowed'] } })
    expect(haveNow.total).toBe(0)
    await expect(api.catalog.changeHolding({ editionId, change: { action: 'returned', on: '2026-01-02' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('adds a borrowed library book that no source knows about', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({
      work: { ...dune, editions: [{ format: 'physical', ownership: 'borrowed', holdingNote: 'City library' }] },
    })
    const book = await api.catalog.get({ workId })
    expect(book.availability).toBe('borrowed')
    expect(book.editions[0]?.history[0]).toMatchObject({ type: 'borrowed', note: 'City library' })
  })

  it('maps hidden works to NOT_FOUND across routers', async () => {
    const admin = await h.asNewUser('admin')
    const kid = await h.asNewUser()
    const { workId } = await admin.api.catalog.create({ work: dune })
    await hideWorkFromUser(h.db, await loadUserScope(h.db, admin.user), kid.user.id, workId)
    await expect(kid.api.catalog.get({ workId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.catalog.update({ workId, patch: { title: 'x' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await kid.api.library.search({ q: 'dune' })).items).toEqual([])
    const titleId = (await admin.api.catalog.get({ workId })).titleId
    await expect(kid.api.catalog.titles.add({ workId, language: 'he', title: 'x', subtitle: null })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.catalog.titles.update({ titleId, title: 'x', subtitle: null, language: 'en' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.catalog.titles.makePrimary({ titleId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.catalog.titles.remove({ titleId, newPrimaryId: null })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await kid.api.catalog.facets()).authors).toEqual([])
  })

  it('searches the visible catalog and returns nothing for blank queries', async () => {
    const { api } = await h.asNewUser()
    await api.catalog.create({ work: dune, addToMyBooks: false })
    expect((await api.library.search({ q: 'herbert dune' })).items.map((i) => i.title)).toEqual(['Dune'])
    expect((await api.library.search({ q: '   ' })).items).toEqual([])
  })

  it('only lets admins delete books', async () => {
    const member = await h.asNewUser()
    const admin = await h.asNewUser('admin')
    const { workId } = await member.api.catalog.create({ work: dune })
    await expect(member.api.catalog.delete({ workId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await admin.api.catalog.delete({ workId })
    await expect(admin.api.catalog.get({ workId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('suggests names from the books the user can see, and needs a login', async () => {
    const { api } = await h.asNewUser()
    await api.catalog.create({ work: { ...dune, series: [{ name: 'Dune Chronicles', position: 1 }], tags: ['Classic'] } })
    const s = await api.catalog.suggestions()
    expect(s.series.map((x) => x.name)).toEqual(['Dune Chronicles'])
    expect(s.contributors).toEqual(['Frank Herbert'])
    expect(s.tags).toEqual(['Classic'])
    await expect(h.call().api.catalog.suggestions()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('sets an edition cover from a book site, replacing the old one, and refuses other hosts, non-images and hidden books', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: dune })
    const editionId = (await api.catalog.get({ workId })).editions[0]?.id ?? ''
    await api.catalog.setCoverFromPage({ editionId, coverUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg' })
    const first = (await api.catalog.get({ workId })).coverAssetId
    expect(first).not.toBeNull()
    // the same picture again: one stored file, still the copy's cover
    await api.catalog.setCoverFromPage({ editionId, coverUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg' })
    expect((await api.catalog.get({ workId })).coverAssetId).toBe(first)

    await expect(api.catalog.setCoverFromPage({ editionId, coverUrl: 'https://evil.example/1.jpg' })).rejects.toMatchObject({ message: 'That cover is not from a book site My Library knows' })
    await expect(api.catalog.setCoverFromPage({ editionId, coverUrl: 'https://covers.openlibrary.org/b/id/2-L.jpg' })).rejects.toMatchObject({ message: "The cover couldn't be downloaded — try again in a minute" })
    await expect(api.catalog.setCoverFromPage({ editionId, coverUrl: 'https://covers.openlibrary.org/b/id/3-L.jpg' })).rejects.toMatchObject({ message: "The cover couldn't be downloaded — try again in a minute" })

  })

  it('never downloads a cover for a book hidden from me', async () => {
    const admin = await h.asNewUser('admin')
    const kid = await h.asNewUser()
    const { workId } = await admin.api.catalog.create({ work: dune })
    const editionId = (await admin.api.catalog.get({ workId })).editions[0]?.id ?? ''
    await hideWorkFromUser(h.db, await loadUserScope(h.db, admin.user), kid.user.id, workId)
    await expect(kid.api.catalog.setCoverFromPage({ editionId, coverUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await admin.api.catalog.get({ workId })).coverAssetId).toBeNull()
  })

  it('uploads a cover from a file (#100): pictures only, never to a hidden book', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const admin = await h.asNewUser('admin')
    const kid = await h.asNewUser()
    const { workId } = await admin.api.catalog.create({ work: dune })
    const editionId = (await admin.api.catalog.get({ workId })).editions[0]?.id ?? ''
    await expect(admin.api.catalog.uploadCover({ editionId, imageBase64: Buffer.from('not a picture').toString('base64') })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await admin.api.catalog.uploadCover({ editionId, imageBase64: png })
    expect((await admin.api.catalog.get({ workId })).coverAssetId).not.toBeNull()
    await hideWorkFromUser(h.db, await loadUserScope(h.db, admin.user), kid.user.id, workId)
    await expect(kid.api.catalog.uploadCover({ editionId, imageBase64: png })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('fetches a picture from an address for the page, and says why one is refused', async () => {
    const { api } = await h.asNewUser()
    const got = await api.catalog.fetchCoverUrl({ url: COVER_URL_TEST })
    expect(got.mime).toBe('image/png')
    expect(Buffer.from(got.imageBase64, 'base64')).toEqual(Buffer.from(COVER_PNG))
    await expect(api.catalog.fetchCoverUrl({ url: 'http://192.168.1.10/x.png' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'That address is not on the public internet' })
  })

  it('adds, edits, promotes and removes a title, and shows the titles on the book', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: { ...dune, title: 'דיונה', authors: ['Frank Herbert'] } })
    const { titleId } = await api.catalog.titles.add({ workId, language: 'English', title: 'Dune', subtitle: null })
    await expect(api.catalog.titles.add({ workId, language: 'en', title: 'Dune 2', subtitle: null })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await api.library.search({ q: 'Dune' })).items.map((i) => i.id)).toContain(workId)
    let book = await api.catalog.get({ workId })
    expect(book.titles.map((r) => [r.language, r.primary])).toEqual([['he', true], ['en', false]])
    expect(book.title).toBe('Dune')
    expect(book.titleId).toBe(titleId)
    await api.catalog.titles.update({ titleId, title: 'Dune!', subtitle: null, language: 'en' })
    await api.catalog.titles.makePrimary({ titleId })
    book = await api.catalog.get({ workId })
    expect(book.primaryTitle).toBe('Dune!')
    const old = book.titles.find((r) => !r.primary)
    await api.catalog.titles.remove({ titleId: old?.id ?? '', newPrimaryId: null })
    expect((await api.catalog.get({ workId })).titles).toHaveLength(1)
    await expect(api.catalog.titles.remove({ titleId, newPrimaryId: null })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'A book needs a title' })
  })
})
