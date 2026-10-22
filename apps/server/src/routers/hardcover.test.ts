import { describe, expect, it } from 'vitest'
import { createWork, saveMatch, setHardcoverAccountStatus, sourceItems, sources } from '@mylib/db'
import { ExternalItem } from '@mylib/domain'
import { seedSession, workInput } from '@mylib/db/testing'
import { useServerHarness } from '../testing/harness'

const TOKEN = 'fixture-hardcover-token-0001'
const data = (id: number) => ({ id, slug: `b-${id}`, title: `B${id}`, rating: 4.2, ratingsCount: 3, tags: { genre: [], mood: [] }, similarIds: [] })

describe('hardcover router', () => {
  const h = useServerHarness()

  it('an admin saves a household token after a test; members cannot', async () => {
    h.hardcover.fixtures = { token: TOKEN, me: { id: 7, username: 'home' }, editions: [] }
    const { api } = await h.asNewUser('admin')
    expect(await api.hardcover.admin.setToken({ token: `Bearer ${TOKEN}` })).toMatchObject({ username: 'home', status: 'ok' })
    expect((await api.hardcover.admin.get()).account).toMatchObject({ username: 'home' })
    expect(JSON.stringify(await api.hardcover.admin.get())).not.toContain(TOKEN)
    const member = await h.asNewUser('member')
    await expect(member.api.hardcover.admin.get()).rejects.toThrow()
  })

  it('a rejected token is not saved', async () => {
    h.hardcover.fixtures = { token: 'some-other-token-entirely-0' }
    const { api } = await h.asNewUser('admin')
    await expect(api.hardcover.admin.setToken({ token: TOKEN })).rejects.toThrow(/rejected the token/)
    expect((await api.hardcover.admin.get()).account).toBeNull()
  })

  it('each person sees only their own account and sends', async () => {
    h.hardcover.fixtures = { token: TOKEN, me: { id: 42, username: 'reader' }, vibes: [] }
    const a = await h.asNewUser('member')
    const b = await h.asNewUser('member')
    await a.api.hardcover.mine.setToken({ token: TOKEN })
    await a.api.hardcover.mine.setSend({ on: true })
    expect((await a.api.hardcover.mine.get()).account).toMatchObject({ username: 'reader', sendFinished: true })
    expect((await b.api.hardcover.mine.get()).account).toBeNull()
    expect(await b.api.hardcover.mine.pushes()).toEqual([])
  })

  it('forWork is disabled without a household token; rejects and links by id', async () => {
    const { api } = await h.asNewUser('admin')
    const w = await createWork(h.db, workInput({ title: 'W' }))
    expect(await api.hardcover.forWork({ workId: w })).toEqual({ enabled: false, view: null })
    h.hardcover.fixtures = { token: TOKEN, me: { id: 7, username: 'home' }, editions: [], books: { 5: { id: 5, slug: 'the-w', title: 'W', rating: 3.9, ratings_count: 8, cached_tags: {}, cached_similar_book_ids: [] } } }
    await api.hardcover.admin.setToken({ token: TOKEN })
    await saveMatch(h.db, w, { kind: 'title', book: data(1) }, new Date())
    await api.hardcover.reject({ workId: w })
    expect((await api.hardcover.forWork({ workId: w })).view).toMatchObject({ match: 'rejected' })
    await api.hardcover.link({ workId: w, hardcoverId: 5 })
    expect((await api.hardcover.forWork({ workId: w })).view).toMatchObject({ match: 'manual', slug: 'the-w', rating: 3.9 })
  })

  describe('Fetch metadata lookups', () => {
    const edition = (id: number, extra: Record<string, unknown> = {}) => ({ id, title: null, isbn_13: null, isbn_10: null, pages: null, release_date: null, edition_format: null, reading_format_id: null, publisher: null, cached_image: null, language: null, ...extra })
    const row = (id: number, slug: string, editions: unknown[]) => ({
      id,
      slug,
      title: 'Worm',
      description: null,
      release_date: '2013-11-19',
      cached_image: null,
      cached_contributors: [{ author: { id: 1, name: 'Wildbow' }, contribution: null }],
      book_series: [],
      default_physical_edition_id: 30647610,
      default_cover_edition_id: null,
      editions,
    })
    const fixtures = (extra: Record<string, unknown> = {}) => ({
      token: TOKEN,
      me: { id: 7, username: 'home' },
      editions: [{ id: 501, isbn_13: '9780141439518', isbn_10: null, book_id: 1001 }],
      search: [{ id: '474572', title: 'Worm', author_names: ['Wildbow'] }],
      pages: {
        474572: row(474572, 'worm-parahumans', [edition(30647610, { pages: 6073 }), edition(30647611, { pages: 4192 }), edition(30647612)]),
        1001: row(1001, 'pride', [edition(501, { pages: 300 })]),
      },
      ...extra,
    })

    it('looks up by text, by a known ISBN and by an unknown one', async () => {
      h.hardcover.fixtures = fixtures()
      const { api } = await h.asNewUser('admin')
      await api.hardcover.admin.setToken({ token: TOKEN })
      h.hardcover.calls.length = 0
      expect(await api.hardcover.lookup({ query: 'Worm Wildbow' })).toMatchObject({ kind: 'results', results: [{ id: 474572 }] })
      expect(h.hardcover.calls).toHaveLength(1)
      h.hardcover.calls.length = 0
      expect(await api.hardcover.lookup({ query: '978-0-14-143951-8' })).toMatchObject({ kind: 'page', editionId: 501, page: { providerId: '1001' } })
      expect(h.hardcover.calls).toHaveLength(2)
      expect(await api.hardcover.lookup({ query: '9780000000002' })).toMatchObject({ kind: 'results', results: [{ id: 474572 }] })
    })

    it('lists versions, reads a page and reads a pasted link', async () => {
      h.hardcover.fixtures = fixtures()
      const { api } = await h.asNewUser('admin')
      await api.hardcover.admin.setToken({ token: TOKEN })
      expect(await api.hardcover.versions({ hardcoverId: 474572 })).toMatchObject({ mainEditionId: 30647610, editions: [{}, {}, {}] })
      expect(await api.hardcover.page({ hardcoverId: 474572, editionId: 30647611 })).toMatchObject({ pageCount: 4192 })
      expect(await api.hardcover.page({ hardcoverId: 474572, editionId: null })).toMatchObject({ pageCount: 6073 })
      expect(await api.hardcover.pageByUrl({ url: 'https://hardcover.app/books/worm-parahumans/editions/30647611' })).toMatchObject({ editionId: 30647611, page: { pageCount: 4192 } })
      expect(await api.hardcover.pageByUrl({ url: 'https://hardcover.app/books/worm-parahumans' })).toMatchObject({ editionId: null })
      await expect(api.hardcover.pageByUrl({ url: 'https://example.com/x' })).rejects.toThrow(/hardcover\.app\/books/)
      await expect(api.hardcover.pageByUrl({ url: 'https://hardcover.app/books/nope' })).rejects.toThrow(/no such book/)
      await expect(api.hardcover.page({ hardcoverId: 99, editionId: null })).rejects.toThrow(/no such book/)
    })

    it('fetching links nothing; no token means unavailable and refused', async () => {
      const w = await createWork(h.db, workInput({ title: 'W' }))
      const { api } = await h.asNewUser('admin')
      expect(await api.hardcover.available()).toEqual({ enabled: false })
      await expect(api.hardcover.lookup({ query: 'Worm' })).rejects.toThrow(/not set up/)
      h.hardcover.fixtures = fixtures()
      await api.hardcover.admin.setToken({ token: TOKEN })
      expect(await api.hardcover.available()).toEqual({ enabled: true })
      await api.hardcover.page({ hardcoverId: 474572, editionId: null })
      expect((await api.hardcover.forWork({ workId: w })).view).toBeNull()
    })

    it('says so when Hardcover is busy or the token is no longer good', async () => {
      h.hardcover.fixtures = fixtures()
      const { api } = await h.asNewUser('admin')
      await api.hardcover.admin.setToken({ token: TOKEN })
      h.hardcover.fixtures = { token: TOKEN, status: 429, body: {} }
      await expect(api.hardcover.page({ hardcoverId: 1, editionId: null })).rejects.toThrow(/busy/)
      const w = await createWork(h.db, workInput({ title: 'W' }))
      await expect(api.hardcover.link({ workId: w, hardcoverId: 1 })).rejects.toThrow(/Hardcover is busy/)
      h.hardcover.fixtures = { token: 'another-token-entirely-0001' }
      await expect(api.hardcover.lookup({ query: 'Worm' })).rejects.toThrow(/new household token/)
    })
  })

  it('suggests the Open Library work’s title for a book that has one, else the book’s own', async () => {
    const { api } = await h.asNewUser('admin')
    const plain = await createWork(h.db, workInput({ title: 'Plain Book', authors: ['Ann Author'] }))
    expect(await api.hardcover.suggestQuery({ workId: plain })).toEqual({ query: 'Plain Book Ann Author', from: 'book' })
    const hebrew = await createWork(h.db, workInput({ title: 'האימפריה האחרונה', authors: ['ברנדון סנדרסון'] }))
    const [source] = await h.db.insert(sources).values({ kind: 'shelf', name: 'Shelf', config: { kind: 'shelf' }, schedule: null }).returning({ id: sources.id })
    const capture = {
      url: 'https://openlibrary.org/works/OL45W',
      title: 'The Final Empire',
      ld: [{ '@type': 'Book', url: 'https://openlibrary.org/works/OL45W', name: 'The Final Empire', author: [{ '@type': 'Person', name: 'Brandon Sanderson' }] }],
      meta: {},
    }
    // the shelf flow keeps the page it read on the item: the suggestion needs no request
    await h.db.insert(sourceItems).values({
      sourceId: source?.id ?? '',
      externalId: 'ol1',
      raw: { capture },
      normalized: ExternalItem.parse({ externalId: 'ol1', format: 'physical', title: 'x', identifiers: { others: { openlibrary: 'OL45W' } } }),
      contentHash: 'h',
      workId: hebrew,
      state: 'linked',
    })
    expect(await api.hardcover.suggestQuery({ workId: hebrew })).toEqual({ query: 'The Final Empire Brandon Sanderson', from: 'openlibrary' })
  })

  it('Refresh now is refused without a working household token, and queues nothing (M8)', async () => {
    const { api } = await h.asNewUser('admin')
    await expect(api.hardcover.admin.refreshNow()).rejects.toThrow(/No household token/)
    h.hardcover.fixtures = { token: TOKEN, me: { id: 7, username: 'home' }, editions: [] }
    const account = await api.hardcover.admin.setToken({ token: TOKEN })
    await setHardcoverAccountStatus(h.db, account.id, 'needs_token', 'rejected', new Date())
    await expect(api.hardcover.admin.refreshNow()).rejects.toThrow(/Needs a new token/)
    expect(h.hardcoverEnqueued).toEqual([])
  })

  it('Send my past reads needs sending on, queues the past reads and a manual send; a second press queues nothing (#140)', async () => {
    h.hardcover.fixtures = { token: TOKEN, me: { id: 42, username: 'reader' }, vibes: [] }
    const { api, user } = await h.asNewUser('member')
    await expect(api.hardcover.mine.sendPast()).rejects.toThrow(/Link your Hardcover/)
    await api.hardcover.mine.setToken({ token: TOKEN })
    const w = await createWork(h.db, workInput({ title: 'Old read' }))
    await seedSession(h.db, { userId: user.id, workId: w, startedOn: '2020-01-01', outcome: 'finished', finishedOn: '2020-02-01' })
    await expect(api.hardcover.mine.sendPast()).rejects.toThrow(/Turn on/)
    await api.hardcover.mine.setSend({ on: true })
    expect(await api.hardcover.mine.pastReads()).toEqual({ total: 1, matched: 0 })
    expect(await api.hardcover.mine.sendPast()).toEqual({ queued: 1 })
    expect(h.hardcoverEnqueued).toEqual([{ kind: 'send', trigger: 'manual', requestedBy: user.id }])
    expect(await api.hardcover.mine.pushCounts()).toEqual({ waiting: 1, sent: 0, skipped: 0 })
    expect(await api.hardcover.mine.sendPast()).toEqual({ queued: 0 })
    expect(h.hardcoverEnqueued).toHaveLength(1)
  })

  it('Refresh now queues a manual refresh', async () => {
    h.hardcover.fixtures = { token: TOKEN, me: { id: 7, username: 'home' }, editions: [] }
    const { api, user } = await h.asNewUser('admin')
    await api.hardcover.admin.setToken({ token: TOKEN })
    await api.hardcover.admin.refreshNow()
    expect(h.hardcoverEnqueued).toEqual([{ kind: 'refresh', trigger: 'manual', requestedBy: user.id }])
  })
})
