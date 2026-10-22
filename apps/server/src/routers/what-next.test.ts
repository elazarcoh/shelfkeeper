import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string, author: string) => ({ title, authors: [author], editions: [{ format: 'physical' as const, pageCount: 300 }] })
const answer = (...titles: string[]) => JSON.stringify(titles.map((title) => ({ title, authors: ['Ann Author'], reason: 'you liked it' })))

describe('what-next router', () => {
  const h = useServerHarness()

  async function finished(api: Awaited<ReturnType<typeof h.asNewUser>>['api'], title: string, author: string) {
    const { workId } = await api.catalog.create({ work: book(title, author) })
    const { sessionId } = await api.sessions.start({ workId, editionId: null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    await api.sessions.complete({ sessionId, completion: { outcome: 'finished', finishedOn: '2026-10-10', finishedPrecision: 'day', fractionCompleted: null } })
    return workId
  }

  it('get works with no Hardcover account, with shelf picks', async () => {
    const { api } = await h.asNewUser()
    await api.catalog.create({ work: book('Unread', 'Ann Author') })
    const view = await api.whatNext.get({ mood: null, format: 'any', today: '2026-10-20' })
    expect(view.exploreEnabled).toBe(false)
    expect(view.lists.map((l) => l.source)).toContain('shelf')
  })

  it('parseAnswer drops a read book, saves the text, and another user does not see it', async () => {
    const dana = await h.asNewUser()
    const noa = await h.asNewUser()
    await finished(dana.api, 'Old Book', 'Ann Author')
    const text = answer('Old Book', 'New Book')
    const parsed = await dana.api.whatNext.parseAnswer({ text })
    expect(parsed).toMatchObject({ alreadyRead: 1, unusable: 0, picks: [{ title: 'New Book', onWishlist: false }] })
    expect((await dana.api.whatNext.get({ mood: null, format: null, today: '2026-10-20' })).aiAnswer?.text).toBe(text)
    expect((await noa.api.whatNext.get({ mood: null, format: null, today: '2026-10-20' })).aiAnswer).toBeNull()
    await dana.api.whatNext.clearAnswer()
    expect((await dana.api.whatNext.get({ mood: null, format: null, today: '2026-10-20' })).aiAnswer).toBeNull()
  })

  it('parseAnswer with save false reads the answer without changing the stored one', async () => {
    const { api } = await h.asNewUser()
    const first = answer('New Book')
    await api.whatNext.parseAnswer({ text: first })
    const parsed = await api.whatNext.parseAnswer({ text: answer('Other Book'), save: false })
    expect(parsed.picks[0]?.title).toBe('Other Book')
    expect((await api.whatNext.get({ mood: null, format: null, today: '2026-10-20' })).aiAnswer?.text).toBe(first)
  })

  it('parseAnswer refuses an unreadable answer with INVALID and marks wished picks', async () => {
    const { api } = await h.asNewUser()
    await expect(api.whatNext.parseAnswer({ text: 'no list here' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const pick = { title: 'New Book', authors: ['Ann Author'], kind: 'book' as const, series: null, position: null, url: null, format_note: null, reason: 'because' }
    await api.whatNext.wish({ kind: 'ai', pick })
    expect((await api.whatNext.parseAnswer({ text: answer('New Book') })).picks[0]?.onWishlist).toBe(true)
  })

  it('wish creates once', async () => {
    const { api } = await h.asNewUser()
    const pick = { title: 'New Book', authors: ['Ann Author'], kind: 'book' as const, series: null, position: null, url: null, format_note: null, reason: 'because' }
    const first = await api.whatNext.wish({ kind: 'ai', pick })
    const second = await api.whatNext.wish({ kind: 'ai', pick })
    expect(first.created).toBe(true)
    expect(second).toEqual({ workId: first.workId, created: false })
  })

  it('prompt does not contain another user\'s book titles', async () => {
    const dana = await h.asNewUser()
    const noa = await h.asNewUser()
    await finished(dana.api, 'Danas Secret Read', 'Ann Author')
    await finished(noa.api, 'Noas Own Read', 'Bo Writer')
    const { prompt } = await noa.api.whatNext.prompt({ mood: 'surprise', format: 'any', today: '2026-10-20' })
    expect(prompt).toContain('Noas Own Read')
    expect(prompt).not.toContain('Danas Secret Read')
  })

  it('hide, follow and format round-trip', async () => {
    const { api } = await h.asNewUser()
    await api.whatNext.hide({ key: 'shelf:x' })
    await api.whatNext.unhide({ key: 'shelf:x' })
    await api.whatNext.follow({ author: { hardcoverAuthorId: 7, name: 'Ann Author' }, mode: 'follow' })
    expect(await api.whatNext.follows()).toMatchObject([{ hardcoverAuthorId: 7, mode: 'follow' }])
    await api.whatNext.follow({ author: { hardcoverAuthorId: 7, name: 'Ann Author' }, mode: null })
    expect(await api.whatNext.follows()).toEqual([])
    await api.whatNext.setFormat({ format: 'audio' })
    expect((await api.whatNext.get({ mood: null, format: null, today: '2026-10-20' })).format).toBe('audio')
  })
})
