import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { absPushFields } from '@mylib/domain'
import { contributorNames, editions, healthIgnores, seriesNames, sourceItems, sources, workTitles } from '../schema'
import { seedName, seedUser, seedWork, useTestDb } from '../testing'
import {
  absFieldHash,
  countAbsOutOfSync,
  failRunningAbsPushRuns,
  finishAbsPushRun,
  getAbsPushFields,
  getAbsPushRun,
  lastAbsPushRun,
  listAbsOutOfSync,
  loadAbsPushTargets,
  recordAbsPushResult,
  setAbsPushFields,
  startAbsPushRun,
} from './abs-push'
import { healthCounts } from './health'

const raw = (over: Record<string, unknown> = {}) => ({ id: 'li_1', media: { metadata: { title: 'x', authors: [], narrators: [], series: [], ...over } } })

describe('Audiobookshelf push (#115)', () => {
  const t = useTestDb()

  async function setup() {
    const user = await seedUser(t.db, { role: 'admin' })
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    return { user, sourceId: source.id }
  }

  async function linkItem(sourceId: string, editionId: string, workId: string, externalId: string, metadata: Record<string, unknown>, over: Partial<typeof sourceItems.$inferInsert> = {}) {
    const [row] = await t.db
      .insert(sourceItems)
      .values({
        sourceId,
        externalId,
        raw: raw(metadata),
        normalized: { externalId, format: 'audiobook', title: 'x', authors: [], narrators: [], series: [], identifiers: { others: {} }, tags: [] } as never,
        contentHash: 'h',
        editionId,
        workId,
        state: 'linked',
        ...over,
      })
      .returning({ id: sourceItems.id })
    if (!row) throw new Error('no item')
    return row.id
  }

  async function book(title: string, over: { authors?: string[]; language?: string | null; series?: { name: string; position: number | null }; narrators?: string[] } = {}) {
    const w = await seedWork(t.db, {
      title,
      formats: ['audiobook'],
      authors: over.authors ?? ['Wildbow'],
      language: over.language ?? null,
      ...(over.series ? { series: over.series } : {}),
      ...(over.narrators ? { narrators: over.narrators } : {}),
    })
    return { workId: w.workId, editionId: w.editionIds[0] ?? '' }
  }

  it('lists a linked ABS item whose title differs', async () => {
    const { sourceId } = await setup()
    const b = await book('Worm')
    const id = await linkItem(sourceId, b.editionId, b.workId, 'li_1', { title: 'Worm Audiobook', authors: [{ name: 'Wildbow' }] })
    const { rows } = await listAbsOutOfSync(t.db, { showIgnored: false })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceItemId: id, workId: b.workId, title: 'Worm' })
    expect(rows[0]?.diffs).toMatchObject([{ field: 'title', from: 'Worm Audiobook', to: 'Worm' }])
    expect(rows[0]?.diffs[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('English edition of a Hebrew-primary book sends English names', async () => {
    const { sourceId } = await setup()
    const b = await book('תולעת', { authors: ['ויילדבו'], language: 'he', series: { name: 'סדרה', position: 1 } })
    await t.db.insert(workTitles).values({ workId: b.workId, language: 'en', title: 'Worm', subtitle: 'An English subtitle', sortTitle: 'worm', primary: false })
    const [author] = await t.db.select({ id: contributorNames.contributorId }).from(contributorNames).limit(1)
    await seedName(t.db, author?.id ?? '', 'Wildbow', 'en')
    const [sn] = await t.db.select().from(seriesNames).limit(1)
    await t.db.insert(seriesNames).values({ seriesId: sn?.seriesId ?? '', name: 'Parahumans', normalizedName: 'parahumans', language: 'en' })
    await t.db.update(editions).set({ language: 'en' }).where(eq(editions.id, b.editionId))
    await linkItem(sourceId, b.editionId, b.workId, 'li_1', { title: 'x' })
    const [target] = await loadAbsPushTargets(t.db)
    expect(target?.outgoing).toMatchObject({ title: 'Worm', subtitle: 'An English subtitle', authors: ['Wildbow'], series: [{ name: 'Parahumans', sequence: '1' }], language: 'en' })
    expect(target?.title).toBe('Worm')
  })

  it('no edition language: the credited name, else the primary', async () => {
    const { sourceId } = await setup()
    const b = await book('Worm', { authors: ['Wildbow'], narrators: ['Narrator One'] })
    await linkItem(sourceId, b.editionId, b.workId, 'li_1', { title: 'x' })
    const [target] = await loadAbsPushTargets(t.db)
    expect(target?.outgoing).toMatchObject({ authors: ['Wildbow'], narrators: ['Narrator One'], language: null })
  })

  it('volume: edition volume 5 gives "Worm, Part 5" and the extra series entry', async () => {
    const { sourceId } = await setup()
    const b = await book('Worm')
    await t.db.update(editions).set({ volume: 5 }).where(eq(editions.id, b.editionId))
    await linkItem(sourceId, b.editionId, b.workId, 'li_1', { title: 'x' })
    const [target] = await loadAbsPushTargets(t.db)
    expect(target?.outgoing.title).toBe('Worm, Part 5')
    expect(target?.outgoing.series).toEqual([{ name: 'Worm', sequence: '5' }])
  })

  it('ebook sibling never sends', async () => {
    const { sourceId } = await setup()
    const b = await book('Worm')
    const e = await book('Worm Ebook Copy')
    await linkItem(sourceId, b.editionId, b.workId, 'X', { title: 'x' })
    await linkItem(sourceId, e.editionId, e.workId, 'X:ebook', { title: 'x' })
    expect((await loadAbsPushTargets(t.db)).map((x) => x.absItemId)).toEqual(['X'])
    await t.db.delete(sourceItems).where(eq(sourceItems.externalId, 'X'))
    const [only] = await loadAbsPushTargets(t.db)
    expect(only).toMatchObject({ absItemId: 'X', sourceId })
  })

  it('in sync is not listed; ignored is hidden unless showIgnored', async () => {
    const { sourceId, user } = await setup()
    const ok = await book('Fine')
    await linkItem(sourceId, ok.editionId, ok.workId, 'a', { title: 'Fine', authors: [{ name: 'Wildbow' }] })
    const off = await book('Off')
    const offId = await linkItem(sourceId, off.editionId, off.workId, 'b', { title: 'Other', authors: [{ name: 'Wildbow' }] })
    expect((await listAbsOutOfSync(t.db, { showIgnored: false })).rows.map((r) => r.title)).toEqual(['Off'])
    expect(await countAbsOutOfSync(t.db)).toBe(1)
    await t.db.insert(healthIgnores).values({ checkName: 'abs_out_of_sync', subjectKey: offId, ignoredBy: user.id })
    expect((await listAbsOutOfSync(t.db, { showIgnored: false })).rows).toEqual([])
    expect(await countAbsOutOfSync(t.db)).toBe(0)
    expect((await listAbsOutOfSync(t.db, { showIgnored: true })).rows.map((r) => r.title)).toEqual(['Off'])
  })

  it('removed or unlinked items are not targets; unparseable raw is skipped', async () => {
    const { sourceId } = await setup()
    const mk = async (title: string, externalId: string, over: Partial<typeof sourceItems.$inferInsert>) => {
      const b = await book(title)
      await linkItem(sourceId, b.editionId, b.workId, externalId, { title: 'x' }, over)
    }
    await mk('Removed', 'r', { removedAt: new Date() })
    await mk('Pending', 'p', { state: 'pending' })
    await mk('Bad', 'bad', { raw: { nonsense: true } })
    const [other] = await t.db.insert(sources).values({ kind: 'calibre', name: 'Cal', config: { kind: 'calibre' } }).returning()
    const b = await book('Calibre')
    await linkItem(other?.id ?? '', b.editionId, b.workId, 'c', { title: 'x' })
    expect(await loadAbsPushTargets(t.db)).toEqual([])
  })

  it('loads only the asked source items', async () => {
    const { sourceId } = await setup()
    const a = await book('A')
    const c = await book('C')
    const aId = await linkItem(sourceId, a.editionId, a.workId, 'a', { title: 'x' })
    await linkItem(sourceId, c.editionId, c.workId, 'c', { title: 'x' })
    expect((await loadAbsPushTargets(t.db, [aId])).map((x) => x.sourceItemId)).toEqual([aId])
    expect(await loadAbsPushTargets(t.db, [])).toEqual([])
  })

  it('lastSyncAt is the newest ABS sync', async () => {
    const { sourceId } = await setup()
    const when = new Date('2026-10-20T10:00:00Z')
    await t.db.update(sources).set({ lastSyncAt: when }).where(eq(sources.id, sourceId))
    expect((await listAbsOutOfSync(t.db, { showIgnored: false })).lastSyncAt).toEqual(when)
  })

  it('field choice defaults to all nine and round-trips', async () => {
    const { user } = await setup()
    expect(await getAbsPushFields(t.db, user.id)).toEqual([...absPushFields])
    await setAbsPushFields(t.db, user.id, ['title', 'series'])
    expect(await getAbsPushFields(t.db, user.id)).toEqual(['title', 'series'])
  })

  it('one running run at a time; results append; leftovers fail', async () => {
    const { user } = await setup()
    const books = [{ sourceItemId: '11111111-1111-4111-8111-111111111111', fields: [{ field: 'title' as const, hash: absFieldHash('x') }] }]
    const id = await startAbsPushRun(t.db, user.id, books)
    expect(id).not.toBeNull()
    expect(await startAbsPushRun(t.db, user.id, books)).toBeNull()
    await Promise.all([
      recordAbsPushResult(t.db, id ?? '', { sourceItemId: 'a', title: 'A', outcome: 'sent', message: null }),
      recordAbsPushResult(t.db, id ?? '', { sourceItemId: 'b', title: 'B', outcome: 'failed', message: 'boom' }),
    ])
    expect((await getAbsPushRun(t.db, id ?? ''))?.results).toHaveLength(2)
    expect(await failRunningAbsPushRuns(t.db, 'restarted')).toBe(1)
    expect(await getAbsPushRun(t.db, id ?? '')).toMatchObject({ status: 'failed', error: 'restarted' })
    const next = await startAbsPushRun(t.db, user.id, books)
    expect(next).not.toBeNull()
    await finishAbsPushRun(t.db, next ?? '', 'succeeded', null)
    expect(await lastAbsPushRun(t.db)).toMatchObject({ id: next, status: 'succeeded', request: books })
    expect(await startAbsPushRun(t.db, user.id, books)).not.toBeNull()
  })

  it('healthCounts includes abs_out_of_sync', async () => {
    const { sourceId } = await setup()
    const b = await book('Off')
    await linkItem(sourceId, b.editionId, b.workId, 'b', { title: 'Other' })
    expect((await healthCounts(t.db, { today: '2026-10-21' })).abs_out_of_sync).toBe(1)
  })
})
