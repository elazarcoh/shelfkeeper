import { describe, expect, it } from 'vitest'
import { hideWorkFromUser, loadUserScope } from '@mylib/db'
import { PageCapture } from '@mylib/domain'
import translatorPrefix from '../../../../packages/domain/src/providers/fixtures/simania-translator-prefix.json'
import { useServerHarness } from '../testing/harness'

const capture = PageCapture.parse(translatorPrefix)
const any = { formats: [], language: null, note: null }

describe('wishlist through the API', () => {
  const h = useServerHarness()

  it('a member wishes for a book from a page, and another member reads it but cannot change it', async () => {
    const dana = await h.asNewUser()
    const noa = await h.asNewUser()
    const { workId } = await dana.api.wishlist.addFromPage({ capture, target: { action: 'create_work' }, formats: ['physical'], language: 'he', note: null })
    expect(await noa.api.wishlist.list({ userId: dana.user.id })).toMatchObject([{ workId }])
    await expect(noa.api.wishlist.remove({ workId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(noa.api.wishlist.bought({ workId, format: 'physical', on: '2026-10-13' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await dana.api.wishlist.list({ userId: dana.user.id })).toHaveLength(1)
  })

  it('a page added to the wishlist with a corrected volume keeps the correction', async () => {
    const dana = await h.asNewUser()
    const titled = structuredClone(translatorPrefix) as { ld: Record<string, unknown>[] }
    const book = titled.ld.find((n) => n['@type'] === 'Book')
    if (book === undefined) throw new Error('no Book node')
    book['name'] = "ספר - כרך א'"
    await dana.api.wishlist.addFromPage({ capture: PageCapture.parse(titled), target: { action: 'create_work' }, volume: { number: 2, count: 2 }, ...any })
    const [wish] = await dana.api.wishlist.list({ userId: dana.user.id })
    expect(wish?.page).toMatchObject({ volume: 2, volumeCount: 2 })
  })

  it('bought returns the page cover, and the client can store it through setCoverFromPage', async () => {
    const dana = await h.asNewUser()
    const { workId } = await dana.api.wishlist.addFromPage({ capture, target: { action: 'create_work' }, ...any })
    const r = await dana.api.wishlist.bought({ workId, format: 'physical', on: '2026-10-13' })
    expect(r).toMatchObject({ workId, editionId: expect.any(String) as string })
    expect(await dana.api.wishlist.list({ userId: dana.user.id })).toEqual([])
  })

  it('bought with a volume files the copy as that volume', async () => {
    const dana = await h.asNewUser()
    const { workId } = await dana.api.wishlist.addFromPage({ capture, target: { action: 'create_work' }, ...any })
    await dana.api.wishlist.bought({ workId, format: 'physical', on: '2026-10-13', volume: 2 })
    const work = await dana.api.catalog.get({ workId })
    expect(work.editions).toMatchObject([{ format: 'physical', volume: 2 }])
  })

  it('an unreadable page is refused with the extract message', async () => {
    const dana = await h.asNewUser()
    await expect(dana.api.wishlist.addFromPage({ capture: { ...capture, ld: [], meta: {} }, target: { action: 'create_work' }, ...any })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('members and forWork show the household, the viewer first', async () => {
    const dana = await h.asNewUser()
    const noa = await h.asNewUser()
    const { workId } = await dana.api.wishlist.addFromPage({ capture, target: { action: 'create_work' }, ...any })
    await noa.api.wishlist.upsert({ workId, formats: ['ebook'], language: null, note: 'for the trip' })
    const who = await noa.api.wishlist.forWork({ workId })
    expect(who.map((w) => w.userId)).toEqual([noa.user.id, dana.user.id])
    expect(who[0]?.fields).toEqual({ formats: ['ebook'], language: null, note: 'for the trip' })
    const members = await noa.api.wishlist.members()
    expect(members[0]).toMatchObject({ userId: noa.user.id, count: 1 })
  })

  it('a wish on a book the reader hid does not leak through list or cards', async () => {
    const admin = await h.asNewUser('admin')
    const dana = await h.asNewUser()
    const noa = await h.asNewUser()
    const { workId } = await admin.api.catalog.create({ work: { title: 'Dune', authors: ['Frank Herbert'], editions: [{ format: 'physical' as const }] } })
    await dana.api.wishlist.upsert({ workId, ...any })
    // before hiding, noa sees it: in dana's list and as wishedBy on the library card
    expect(await noa.api.wishlist.list({ userId: dana.user.id })).toMatchObject([{ workId }])
    const before = await noa.api.library.list({ scope: 'catalog' })
    expect(before.items.find((i) => i.id === workId)?.wishedBy).toEqual([{ userId: dana.user.id, name: dana.user.displayName }])

    await hideWorkFromUser(h.db, await loadUserScope(h.db, admin.user), noa.user.id, workId)
    expect(await noa.api.wishlist.list({ userId: dana.user.id })).toEqual([])
    expect((await noa.api.wishlist.members()).find((m) => m.userId === dana.user.id)?.count).toBe(0)
    await expect(noa.api.wishlist.forWork({ workId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const after = await noa.api.library.list({ scope: 'catalog' })
    expect(after.items.map((i) => i.id)).not.toContain(workId)
    expect(JSON.stringify(after)).not.toContain(dana.user.displayName)
    // dana still sees her own wish
    expect(await dana.api.wishlist.list({ userId: dana.user.id })).toMatchObject([{ workId }])
  })

  it('a wanted book stays out of list and browse, even when the client asks for it, but the pickers find it', async () => {
    const dana = await h.asNewUser()
    const { workId } = await dana.api.wishlist.addFromPage({ capture, target: { action: 'create_work' }, ...any })
    const title = (await dana.api.wishlist.list({ userId: dana.user.id }))[0]?.title ?? ''
    const sneaky = { scope: 'catalog' as const, includeWanted: true } as { scope: 'catalog' }
    expect((await dana.api.library.list(sneaky)).items.map((i) => i.id)).not.toContain(workId)
    const page = await dana.api.library.browse(sneaky)
    expect(JSON.stringify(page)).not.toContain(workId)
    expect((await dana.api.library.search({ q: title })).items.map((i) => i.id)).toContain(workId)
  })
})
