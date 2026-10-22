import { describe, expect, it } from 'vitest'
import { findVisibleAsset, hardcoverBooks, loadUserScope } from '@mylib/db'
import { COVER_PNG } from '@mylib/connectors/testing'
import { testConfig, useServerHarness } from '../testing/harness'
import { openLibraryFetches } from '../testing/openlibrary-fixture'
import { simaniaFetches } from '../testing/simania-fixture'
import { nliFetches } from '../testing/nli-fixture'

const row = { title: 'המושבה האבודה', subtitle: null, authors: ['אואן קולפר'], translators: [], publisher: null, series: 'ארטמיס פאול', seriesNumber: null, language: 'he', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null }
const batch = (batchId: string) => ({ batchId, label: 'Shelf · 12 Oct', ownership: 'owned' as const, borrowedFrom: null, rows: [{ row, preset: null, capture: null }] })

describe('shelf through the API', () => {
  const h = useServerHarness()

  it('a member imports a batch, links a pasted Simania link (fetched once), accepts it, and its cover is queued', async () => {
    const { api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('66666666-6666-4666-8666-666666666666'))
    const proposalId = proposalIds[0] ?? ''
    const link = 'הנה: https://www.simania.co.il/bookdetails.php?item_id=690482'
    expect(await api.shelf.fetchPage({ proposalId, text: link })).toMatchObject({ title: 'המושבה האבודה' })
    expect(simaniaFetches).toEqual(['https://simania.co.il/bookdetails.php?item_id=690482'])
    await api.shelf.fetchPage({ proposalId, text: link })
    expect(simaniaFetches).toHaveLength(1)
    const { items } = await api.inbox.mine()
    expect(items[0]).toMatchObject({ sourceKind: 'shelf', photo: { link: { providerId: '690482' } } })
    const { workId } = await api.inbox.resolveMine({ proposalId, resolution: { action: 'create_work' }, today: '2026-10-12' })
    expect(workId).not.toBeNull()
    expect(h.coversEnqueued).toHaveLength(1)
  })

  it('queues the covers of books made or accepted in bulk', async () => {
    const { api } = await h.asNewUser()
    const link = 'https://simania.co.il/bookdetails.php?item_id=690482'
    const first = await api.shelf.import(batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
    await api.shelf.fetchPage({ proposalId: first.proposalIds[0] ?? '', text: link })
    expect(await api.inbox.createMineUnmatched({ today: '2026-10-12' })).toEqual({ created: 1, skipped: 0, remaining: 0 })
    expect(h.coversEnqueued).toEqual([first.sourceId])

    h.coversEnqueued.length = 0
    const second = await api.shelf.import(batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
    await api.shelf.fetchPage({ proposalId: second.proposalIds[0] ?? '', text: link })
    expect(await api.inbox.acceptMineExact({ today: '2026-10-12' })).toEqual({ accepted: 1, remaining: 0 })
    expect(h.coversEnqueued).toEqual([second.sourceId])
  })

  it('resolving a shelf proposal with ignore queues no covers', async () => {
    const { api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('99999999-9999-4999-8999-999999999999'))
    const { workId } = await api.inbox.resolveMine({ proposalId: proposalIds[0] ?? '', resolution: { action: 'ignore' }, today: '2026-10-12' })
    expect(workId).toBeNull()
    expect(h.coversEnqueued).toEqual([])
  })

  it('fetchPage refuses other sites, pages without a book id, and redirects', async () => {
    const { api } = await h.asNewUser()
    await expect(api.shelf.fetchPage({ proposalId: null, text: 'https://evil.example/bookdetails.php?item_id=1' })).rejects.toMatchObject({ message: 'Paste the link of a book page on Simania or Open Library' })
    await expect(api.shelf.fetchPage({ proposalId: null, text: 'https://simania.co.il/authorDetails.php?itemId=3' })).rejects.toMatchObject({ message: 'Paste the link of a book page on Simania or Open Library' })
    await expect(api.shelf.fetchPage({ proposalId: null, text: 'https://simania.co.il/bookdetails.php?item_id=999' })).rejects.toMatchObject({ message: "Simania didn't answer — use the bookmarklet instead" })
  })

  it('keeps a batch private to its importer', async () => {
    const { api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('77777777-7777-4777-8777-777777777777'))
    const { api: other } = await h.asNewUser()
    await expect(other.shelf.unlinkPage({ proposalId: proposalIds[0] ?? '' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await other.inbox.mine()).items).toEqual([])
  })

  it('extract returns the page, and a non-book capture is a BAD_REQUEST', async () => {
    const { api } = await h.asNewUser()
    const { capture } = await api.shelf.fetchPage({ proposalId: null, text: 'https://simania.co.il/bookdetails.php?item_id=690482' })
    expect(await api.shelf.extract({ capture })).toMatchObject({ title: 'המושבה האבודה', providerId: '690482' })
    await expect(api.shelf.extract({ capture: { url: 'https://example.com/', title: '', ld: [], meta: {} } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('addOne adds a book from a page and queues its cover', async () => {
    const { api } = await h.asNewUser()
    const { capture } = await api.shelf.fetchPage({ proposalId: null, text: 'https://simania.co.il/bookdetails.php?item_id=690482' })
    const { workId } = await api.shelf.addOne({ batchId: '88888888-8888-4888-8888-888888888888', label: 'Simania · 12 Oct', ownership: 'owned', borrowedFrom: null, row: null, capture, target: { action: 'create_work' }, today: '2026-10-12' })
    expect((await api.catalog.get({ workId })).title).toBe('המושבה האבודה')
    expect(h.coversEnqueued).toHaveLength(1)
  })

  it('search asks Open Library once, naming the app, and returns the works as links', async () => {
    const { api } = await h.asNewUser()
    const { results } = await api.shelf.search({ query: 'artemis fowl lost colony' })
    expect(openLibraryFetches).toHaveLength(1)
    expect(openLibraryFetches[0]?.url).toMatch(/^https:\/\/openlibrary\.org\/search\.json\?q=artemis%20fowl%20lost%20colony&limit=8&/)
    expect(openLibraryFetches[0]?.headers['user-agent']).toMatch(/^MyLibrary\//)
    expect(results[0]?.page).toMatchObject({ provider: 'openlibrary', providerId: 'OL5725977W', title: 'Artemis Fowl. The Lost Colony', authors: ['Eoin Colfer'] })
    const first = results[0]
    if (first === undefined) throw new Error('no result')
    expect(await api.shelf.extract({ capture: first.capture })).toMatchObject({ providerId: 'OL5725977W' })
    expect((await api.shelf.search({ query: 'nothing like it' })).results).toEqual([])
    await expect(api.shelf.search({ query: 'broken' })).rejects.toMatchObject({ message: "Open Library didn't answer — try again in a minute" })
    await expect(api.shelf.search({ query: 'down' })).rejects.toMatchObject({ message: "Open Library didn't answer — try again in a minute" })
    await expect(api.shelf.search({ query: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('a pasted Open Library link is read through the search API by its key, attached, and reused after', async () => {
    const { api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('99999999-9999-4999-8999-999999999999'))
    const proposalId = proposalIds[0] ?? ''
    const link = 'https://openlibrary.org/works/OL8479867W/The_Name_of_the_Wind'
    expect(await api.shelf.fetchPage({ proposalId, text: link })).toMatchObject({ title: 'The Name of the Wind' })
    expect(openLibraryFetches.map((f) => f.url)).toEqual(['https://openlibrary.org/search.json?q=key%3A%2Fworks%2FOL8479867W&limit=1&fields=key,title,author_name,first_publish_year,cover_i,series_name,series_position'])
    await api.shelf.fetchPage({ proposalId: null, text: link })
    expect(openLibraryFetches).toHaveLength(1)
    const { items } = await api.inbox.mine()
    expect(items[0]).toMatchObject({ photo: { link: { provider: 'openlibrary', providerId: 'OL8479867W', url: 'https://openlibrary.org/works/OL8479867W' } }, item: { title: 'The Name of the Wind', series: [{ name: 'The Kingkiller Chronicle', position: 1 }] } })
    await expect(api.shelf.fetchPage({ proposalId: null, text: 'https://openlibrary.org/works/OL1W' })).rejects.toMatchObject({ message: "Open Library doesn't know that book" })
    await api.inbox.resolveMine({ proposalId, resolution: { action: 'create_work' }, today: '2026-10-12' })
    expect(h.coversEnqueued).toHaveLength(1)
  })

  it("a pasted edition link brings that edition's cover, publisher and ISBNs, on its work (#102)", async () => {
    const { api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('99999999-9999-4999-8999-999999999998'))
    const proposalId = proposalIds[0] ?? ''
    expect(await api.shelf.fetchPage({ proposalId, text: 'https://openlibrary.org/books/OL7353617M/Fantastic_Mr._Fox' })).toMatchObject({ title: 'Fantastic Mr Fox' })
    // the search for the work and the edition, then the edition's own record for its page count
    const [searched, details] = openLibraryFetches.map((f) => f.url)
    expect(searched).toMatch(/^https:\/\/openlibrary\.org\/search\.json\?q=edition_key%3AOL7353617M&limit=1&fields=.*,editions\.cover_i,/)
    expect(details).toBe('https://openlibrary.org/api/books?bibkeys=OLID%3AOL7353617M&format=json&jscmd=details')
    expect(openLibraryFetches[1]?.headers['user-agent']).toMatch(/^MyLibrary\//)
    const { items } = await api.inbox.mine()
    expect(items[0]).toMatchObject({
      photo: { link: { provider: 'openlibrary', providerId: 'OL45804W', url: 'https://openlibrary.org/books/OL7353617M' } },
      item: { publisher: 'Puffin', pageCount: 96, coverUrl: 'https://covers.openlibrary.org/b/id/15152634-L.jpg', identifiers: { isbn13: '9780140328721', others: { openlibrary: 'OL45804W' } } },
    })
  })

  it("an edition link still works when the edition's record can't be read, just without its page count", async () => {
    const { api } = await h.asNewUser()
    const { capture } = await api.shelf.fetchPage({ proposalId: null, text: 'https://openlibrary.org/books/OL9M' })
    expect(openLibraryFetches.map((f) => f.url)).toHaveLength(2)
    expect(await api.shelf.extract({ capture })).toMatchObject({ providerId: 'OL45804W', url: 'https://openlibrary.org/books/OL9M', pageCount: null })
  })

  describe('attachHardcover', () => {
    const TOKEN = 'fixture-hardcover-token-0001'
    const wormRow = {
      id: 474572, slug: 'worm-parahumans', title: 'Worm', description: null, release_date: '2013-11-19', cached_image: null,
      cached_contributors: [{ author: { id: 1, name: 'Wildbow' }, contribution: null }], book_series: [],
      default_physical_edition_id: null, default_cover_edition_id: null, editions: [],
    }
    const setup = async () => {
      h.hardcover.fixtures = { token: TOKEN, me: { id: 7, username: 'home' }, editions: [], pages: { 474572: wormRow } }
      const { api: admin } = await h.asNewUser('admin')
      await admin.hardcover.admin.setToken({ token: TOKEN })
      const { proposalIds } = await admin.shelf.import(batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))
      return { api: admin, proposalId: proposalIds[0] ?? '' }
    }

    it('links the Inbox item with one request, and the book only when it is added', async () => {
      const { api, proposalId } = await setup()
      h.hardcover.calls.length = 0
      expect(await api.shelf.attachHardcover({ proposalId, hardcoverId: 474572, editionId: null })).toEqual({ title: 'Worm' })
      expect(h.hardcover.calls).toHaveLength(1)
      const { items } = await api.inbox.mine()
      expect(items[0]).toMatchObject({ item: { identifiers: { others: { hardcover: '474572' } } }, photo: { link: { provider: 'hardcover', providerId: '474572' } } })
      expect(await h.db.select().from(hardcoverBooks)).toEqual([])

      const { workId } = await api.inbox.resolveMine({ proposalId, resolution: { action: 'create_work' }, today: '2026-10-12' })
      expect(await h.db.select().from(hardcoverBooks)).toMatchObject([{ workId, hardcoverId: 474572, match: 'manual' }])
    })

    it('unlinking takes the Hardcover id back off, and a book Hardcover does not have is refused', async () => {
      const { api, proposalId } = await setup()
      await api.shelf.attachHardcover({ proposalId, hardcoverId: 474572, editionId: null })
      await api.shelf.unlinkPage({ proposalId })
      const { items } = await api.inbox.mine()
      expect(items[0]?.item.identifiers.others).not.toHaveProperty('hardcover')
      await expect(api.shelf.attachHardcover({ proposalId, hardcoverId: 99, editionId: null })).rejects.toThrow(/no such book/)
    })
  })
})

// #157: a scanned barcode is looked up by its ISBN
describe('shelf.byIsbn', () => {
  const h = useServerHarness()

  it('finds an Israeli ISBN at the National Library first, with the key, and the review reads it', async () => {
    const { api } = await h.asNewUser()
    const found = await api.shelf.byIsbn({ isbn: '978-965-531-032-0' })
    expect(found).toMatchObject({ isbn: '9789655310320', have: null, tried: ['nli'], failed: [] })
    if (found.capture === null) throw new Error('not found')
    expect(found.capture.url).toBe('https://www.nli.org.il/en/books/NNL_ALEPH990026932820205171')
    expect(nliFetches).toHaveLength(1)
    expect(new URL(nliFetches[0] ?? '').searchParams.get('api_key')).toBe('test-nli-key')
    expect(openLibraryFetches).toEqual([])
    expect(await api.shelf.extract({ capture: found.capture })).toMatchObject({ provider: 'nli', title: 'לויתני האפר', isbn13: '9789655310320' })
  })

  it('asks Open Library first for any other ISBN, in one request', async () => {
    const { api } = await h.asNewUser()
    const found = await api.shelf.byIsbn({ isbn: '9780747538486' })
    expect(found).toMatchObject({ tried: ['openlibrary'], failed: [] })
    expect(found.capture?.url).toBe('https://openlibrary.org/books/OL59041259M')
    expect(openLibraryFetches).toHaveLength(1)
    expect(nliFetches).toEqual([])
  })

  it('tries the National Library after Open Library, by both forms of the ISBN, and says where it looked', async () => {
    const { api } = await h.asNewUser()
    // Open Library's fake doesn't know it; the National Library's record holds only the 10-digit form
    const found = await api.shelf.byIsbn({ isbn: '9780140328721' })
    expect(found.tried).toEqual(['openlibrary', 'nli'])
    expect(found.capture?.url).toBe('https://www.nli.org.il/en/books/NNL_ALEPH990020463320205171')
    expect(nliFetches.map((u) => new URL(u).searchParams.get('query'))).toEqual(['any,contains,9780140328721', 'any,contains,0140328726'])

    const none = await api.shelf.byIsbn({ isbn: '9780441172719' })
    expect(none).toMatchObject({ capture: null, tried: ['openlibrary', 'nli'], failed: [] })
  })

  it('says it is already here, by either form of the ISBN', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: { title: 'Dune', authors: ['Frank Herbert'], editions: [{ format: 'physical', isbn10: '0441172717' }] } })
    expect((await api.shelf.byIsbn({ isbn: '9780441172719' })).have).toEqual({ workId, title: 'Dune' })
  })

  it('refuses what is not an ISBN, and skips the National Library without a key', async () => {
    const { api } = await h.asNewUser()
    await expect(api.shelf.byIsbn({ isbn: '7290000068756' })).rejects.toThrow("That isn't an ISBN")
    testConfig.nliApiKey = null
    try {
      const found = await api.shelf.byIsbn({ isbn: '9789655310320' })
      expect(found).toMatchObject({ capture: null, tried: ['openlibrary'] })
      expect(nliFetches).toEqual([])
      await expect(api.shelf.fetchPage({ proposalId: null, text: 'https://www.nli.org.il/en/books/NNL_ALEPH990026932820205171' })).rejects.toThrow('NLI_API_KEY')
    } finally {
      testConfig.nliApiKey = 'test-nli-key'
    }
  })

  it('reads a pasted National Library link by its record id', async () => {
    const { api } = await h.asNewUser()
    expect(await api.shelf.fetchPage({ proposalId: null, text: 'https://www.nli.org.il/he/books/NNL_ALEPH990026932820205171' })).toMatchObject({ title: 'לויתני האפר' })
    expect(nliFetches.map((u) => new URL(u).searchParams.get('query'))).toEqual(['any,contains,990026932820205171'])
  })
})

// #161: a cover photo taken for a book still in the Inbox
describe('shelf.setCover', () => {
  const h = useServerHarness()
  const png = Buffer.from(COVER_PNG).toString('base64')

  it('keeps the photo with the waiting book, shows it only to its owner, and makes it the copy’s cover on Accept', async () => {
    const { user, api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))
    const proposalId = proposalIds[0] ?? ''
    await api.shelf.setCover({ proposalId, imageBase64: png })
    const coverAssetId = (await api.inbox.mine()).items[0]?.coverAssetId ?? null
    expect(coverAssetId).not.toBeNull()
    const assetId = coverAssetId ?? ''
    expect(await findVisibleAsset(h.db, await loadUserScope(h.db, user), assetId)).not.toBeNull()
    const other = await h.asNewUser()
    expect(await findVisibleAsset(h.db, await loadUserScope(h.db, other.user), assetId)).toBeNull()
    await expect(other.api.shelf.setCover({ proposalId, imageBase64: png })).rejects.toThrow()

    const { workId } = await api.inbox.resolveMine({ proposalId, resolution: { action: 'create_work' }, today: '2026-10-22' })
    const book = await api.catalog.get({ workId: workId ?? '' })
    expect(book.editions[0]?.coverAssetId).toBe(assetId)
  })

  it('takes the photo off, and refuses what is not a picture', async () => {
    const { api } = await h.asNewUser()
    const { proposalIds } = await api.shelf.import(batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))
    const proposalId = proposalIds[0] ?? ''
    await expect(api.shelf.setCover({ proposalId, imageBase64: Buffer.from('not a picture').toString('base64') })).rejects.toThrow('not a JPEG')
    await api.shelf.setCover({ proposalId, imageBase64: png })
    await api.shelf.setCover({ proposalId, imageBase64: null })
    expect((await api.inbox.mine()).items[0]?.coverAssetId).toBeNull()
    const { workId } = await api.inbox.resolveMine({ proposalId, resolution: { action: 'create_work' }, today: '2026-10-22' })
    expect((await api.catalog.get({ workId: workId ?? '' })).editions[0]?.coverAssetId).toBeNull()
  })
})
