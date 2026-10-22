import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { editionInputFromItem, ExternalItem, type AiPick } from '@mylib/domain'
import { sources, works } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail, mergeWorks, updateWork } from './catalog'
import { loadUserScope } from './scope'
import { addEditionFromForm, addEditionFromItem, applyItemToEdition, createWorkFromItem, formHolding } from './source-catalog'
import { wishFromPick } from './what-next'

const item = (over: Record<string, unknown> = {}) =>
  ExternalItem.parse({ externalId: 'li_1', format: 'ebook', title: 'Some Story', authors: ['Ann'], description: 'A tale.', tags: [], ...over })

const aiPick = (over: Partial<AiPick> = {}): AiPick => ({ title: 'Worm', authors: ['Wildbow'], kind: 'book', series: null, position: null, url: null, format_note: null, reason: 'Gripping', ...over })

describe('automatic work kind', () => {
  const t = useTestDb()

  async function setup() {
    const user = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, user)
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    return { user, scope, sourceId: source.id }
  }

  const create = async (sourceId: string, userId: string, over: Record<string, unknown> = {}) =>
    t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(over), userId))

  describe('from a source item', () => {
    it('a "Fan Fiction" tag makes a fanfiction, from the source and unlocked', async () => {
      const { user, scope, sourceId } = await setup()
      const { workId } = await create(sourceId, user.id, { tags: ['Fan Fiction'] })
      const detail = await getWorkDetail(t.db, scope, workId)
      expect(detail.kind).toBe('fanfiction')
      expect(detail.provenance.kind).toMatchObject({ origin: 'source', sourceId, locked: false })
    })

    it('a royalroad.com link in the description makes a web serial', async () => {
      const { user, scope, sourceId } = await setup()
      const { workId } = await create(sourceId, user.id, { description: 'Read it at https://www.royalroad.com/fiction/1' })
      expect((await getWorkDetail(t.db, scope, workId)).kind).toBe('web_serial')
    })

    it('no signal leaves a plain book with no kind entry', async () => {
      const { user, scope, sourceId } = await setup()
      const { workId } = await create(sourceId, user.id, { tags: ['Fantasy'] })
      const detail = await getWorkDetail(t.db, scope, workId)
      expect(detail.kind).toBe('book')
      expect(detail.provenance.kind).toBeUndefined()
    })

    it('a work set to Book by hand stays Book when a later sync brings a "Fan Fiction" tag', async () => {
      const { user, scope, sourceId } = await setup()
      const { workId, editionId } = await create(sourceId, user.id)
      await updateWork(t.db, scope, workId, { kind: 'book' })
      await applyItemToEdition(t.db, sourceId, editionId, item({ tags: ['Fan Fiction'] }))
      const detail = await getWorkDetail(t.db, scope, workId)
      expect(detail.kind).toBe('book')
      expect(detail.provenance.kind).toMatchObject({ origin: 'manual', locked: true })
    })

    it('a sync promotes an unset book, then the kind is sticky', async () => {
      const { user, scope, sourceId } = await setup()
      const { workId, editionId } = await create(sourceId, user.id)
      expect(await applyItemToEdition(t.db, sourceId, editionId, item({ tags: ['Fan Fiction'] }))).toContain('work.kind')
      expect((await getWorkDetail(t.db, scope, workId)).kind).toBe('fanfiction')
      // another automatic signal never replaces it, and a sync without tags never reverts it
      await applyItemToEdition(t.db, sourceId, editionId, item({ description: 'https://royalroad.com/fiction/2', tags: [] }))
      expect((await getWorkDetail(t.db, scope, workId)).kind).toBe('fanfiction')
      await applyItemToEdition(t.db, sourceId, editionId, item({ tags: [] }))
      expect((await getWorkDetail(t.db, scope, workId)).kind).toBe('fanfiction')
    })

    it('adding a source copy to an existing book applies the rule; a book set by hand stays Book', async () => {
      const { user, scope, sourceId } = await setup()
      const unset = await createWork(t.db, workInput({ title: 'Some Story' }))
      await addEditionFromItem(t.db, sourceId, unset, item({ externalId: 'li_a', tags: ['Fan Fiction'] }), user.id)
      const detail = await getWorkDetail(t.db, scope, unset)
      expect(detail.kind).toBe('fanfiction')
      expect(detail.provenance.kind).toMatchObject({ origin: 'source', sourceId, locked: false })

      const manual = await createWork(t.db, workInput({ title: 'Other Story', kind: 'book' }))
      await addEditionFromItem(t.db, sourceId, manual, item({ externalId: 'li_b', tags: ['Fan Fiction'] }), user.id)
      const locked = await getWorkDetail(t.db, scope, manual)
      expect(locked.kind).toBe('book')
      expect(locked.provenance.kind).toMatchObject({ origin: 'manual', locked: true })
    })

    it('the Add edition form path applies the rule too', async () => {
      const { user, scope, sourceId } = await setup()
      const unset = await createWork(t.db, workInput({ title: 'Some Story' }))
      const it = item({ externalId: 'li_c', description: 'https://www.royalroad.com/fiction/9' })
      const input = editionInputFromItem(it)
      await addEditionFromForm(t.db, sourceId, unset, it, input, user.id, formHolding(input, '2026-01-01', 'Imported'))
      expect((await getWorkDetail(t.db, scope, unset)).kind).toBe('web_serial')
    })
  })

  describe('from an Ask AI pick', () => {
    it('a new wished work takes the pick kind as an automatic AI value', async () => {
      const { scope } = await setup()
      const { workId } = await wishFromPick(t.db, scope, { kind: 'ai', pick: aiPick({ kind: 'fanfiction', url: 'https://archiveofourown.org/works/1' }) })
      const detail = await getWorkDetail(t.db, scope, workId)
      expect(detail.kind).toBe('fanfiction')
      expect(detail.provenance.kind).toMatchObject({ origin: 'ai', locked: false })
    })

    it('a book pick leaves the new work a plain book', async () => {
      const { scope } = await setup()
      const { workId } = await wishFromPick(t.db, scope, { kind: 'ai', pick: aiPick() })
      const detail = await getWorkDetail(t.db, scope, workId)
      expect(detail.kind).toBe('book')
      expect(detail.provenance.kind).toBeUndefined()
    })

    it('an existing unset book takes the kind; one set by hand keeps its own', async () => {
      const { scope } = await setup()
      const unset = await createWork(t.db, workInput({ title: 'Worm', authors: ['Wildbow'] }))
      expect((await wishFromPick(t.db, scope, { kind: 'ai', pick: aiPick({ kind: 'web_serial' }) })).workId).toBe(unset)
      expect((await getWorkDetail(t.db, scope, unset)).kind).toBe('web_serial')

      const manual = await createWork(t.db, workInput({ title: 'Ward', authors: ['Wildbow'], kind: 'book' }))
      await wishFromPick(t.db, scope, { kind: 'ai', pick: aiPick({ title: 'Ward', kind: 'web_serial' }) })
      expect((await t.db.select({ kind: works.kind }).from(works).where(eq(works.id, manual)))[0]?.kind).toBe('book')
    })
  })

  describe('merge', () => {
    it('a manual kind on the source beats an automatic book target and stays locked', async () => {
      const { scope } = await setup()
      const target = await createWork(t.db, workInput({ title: 'Story' }))
      const source = await createWork(t.db, workInput({ title: 'Story', kind: 'fanfiction' }))
      const result = await mergeWorks(t.db, scope, target, [source])
      expect(result.dropped.some((d) => d.startsWith('Kind'))).toBe(false)
      const detail = await getWorkDetail(t.db, scope, target)
      expect(detail.kind).toBe('fanfiction')
      expect(detail.provenance.kind).toMatchObject({ origin: 'manual', locked: true })
    })

    it('two manual kinds that differ keep the target and name the loser', async () => {
      const { scope } = await setup()
      const target = await createWork(t.db, workInput({ title: 'Story', kind: 'web_serial' }))
      const source = await createWork(t.db, workInput({ title: 'Story', kind: 'fanfiction' }))
      const result = await mergeWorks(t.db, scope, target, [source])
      expect(result.dropped).toContain('Kind: Fanfiction (from “Story”)')
      expect((await getWorkDetail(t.db, scope, target)).kind).toBe('web_serial')
    })

    it('a source locked to Book beats an automatic fanfiction target', async () => {
      const { user, scope, sourceId } = await setup()
      const { workId: target } = await create(sourceId, user.id, { tags: ['Fan Fiction'] })
      const source = await createWork(t.db, workInput({ title: 'Some Story', kind: 'book' }))
      await mergeWorks(t.db, scope, target, [source])
      const detail = await getWorkDetail(t.db, scope, target)
      expect(detail.kind).toBe('book')
      expect(detail.provenance.kind).toMatchObject({ origin: 'manual', locked: true })
    })
  })
})
