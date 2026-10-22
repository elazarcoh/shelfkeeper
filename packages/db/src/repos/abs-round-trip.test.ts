import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ExternalItem, parseSeriesPosition } from '@mylib/domain'
import { contributorNames, editionContributors, editions, series, seriesNames, sourceItems, sources, workSeries, workTitles, works } from '../schema'
import { seedName, seedWork, useTestDb } from '../testing'
import { loadAbsPushTargets } from './abs-push'
import { storeSourceItem } from './sync'
import { setPrimaryTitle } from './titles'

// #115: send → sync must leave My Library unchanged (R11 and the volume entry)
describe('Audiobookshelf round trip (#115)', () => {
  const t = useTestDb()

  async function setup(title: string, over: { authors?: string[]; language?: string | null; series?: { name: string; position: number | null }; narrators?: string[]; volume?: number } = {}) {
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    const w = await seedWork(t.db, {
      title,
      formats: ['audiobook'],
      authors: over.authors ?? ['Wildbow'],
      language: over.language ?? null,
      ...(over.series ? { series: over.series } : {}),
      ...(over.narrators ? { narrators: over.narrators } : {}),
    })
    const editionId = w.editionIds[0] ?? ''
    await t.db.update(editions).set({ language: over.language ?? null, ...(over.volume ? { volume: over.volume } : {}) }).where(eq(editions.id, editionId))
    await t.db
      .insert(sourceItems)
      .values({
        sourceId: source?.id ?? '',
        externalId: 'li_1',
        raw: { id: 'li_1', media: { metadata: { title: 'x', authors: [], narrators: [], series: [] } } },
        normalized: { externalId: 'li_1', format: 'audiobook', title: 'x', authors: [], narrators: [], series: [], identifiers: { others: {} }, tags: [] } as never,
        contentHash: 'h',
        editionId,
        workId: w.workId,
        state: 'linked',
      })
    return { sourceId: source?.id ?? '', workId: w.workId, editionId }
  }

  /** The item the next ABS sync would produce from what was sent (names may be overridden: the audiobook's own language). */
  async function readBack(over: Partial<ExternalItem> = {}) {
    const [target] = await loadAbsPushTargets(t.db)
    if (!target) throw new Error('no target')
    const o = target.outgoing
    return ExternalItem.parse({
      externalId: 'li_1',
      format: 'audiobook',
      title: o.title ?? 'x',
      subtitle: o.subtitle,
      authors: o.authors,
      narrators: o.narrators,
      series: o.series.map((s) => ({ name: s.name, ...(parseSeriesPosition(s.sequence ?? '') ?? { position: null, positionEnd: null }) })),
      ...over,
    })
  }

  async function snapshot(workId: string, editionId: string) {
    const [work] = await t.db.select({ title: works.title, subtitle: works.subtitle, provenance: works.provenance }).from(works).where(eq(works.id, workId))
    const [edition] = await t.db.select({ provenance: editions.provenance }).from(editions).where(eq(editions.id, editionId))
    return {
      work,
      edition,
      titles: await t.db.select().from(workTitles).where(eq(workTitles.workId, workId)).orderBy(asc(workTitles.title)),
      series: await t.db.select().from(workSeries).where(eq(workSeries.workId, workId)).orderBy(asc(workSeries.sortIndex)),
      narrators: await t.db.select().from(editionContributors).where(eq(editionContributors.editionId, editionId)).orderBy(asc(editionContributors.role), asc(editionContributors.position)),
      seriesCount: (await t.db.select().from(series)).length,
    }
  }

  it('volume Worm, Part 5 with series Worm #5 does not add a series', async () => {
    const { sourceId, workId, editionId } = await setup('Worm', { volume: 5 })
    const before = await snapshot(workId, editionId)
    const item = await readBack()
    expect(item.series).toEqual([{ name: 'Worm', position: 5, positionEnd: null }])
    await storeSourceItem(t.db, sourceId, item)
    expect(await snapshot(workId, editionId)).toEqual(before)
  })

  it('English names on a Hebrew-primary book change nothing', async () => {
    const { sourceId, workId, editionId } = await setup('תולעת', { authors: ['ויילדבו'], language: 'he', series: { name: 'סדרה', position: 1 }, narrators: ['קריין'] })
    const [sn] = await t.db.select().from(seriesNames).limit(1)
    await t.db.insert(seriesNames).values({ seriesId: sn?.seriesId ?? '', name: 'Parahumans', normalizedName: 'parahumans', language: 'en' })
    const [narrator] = await t.db.select({ id: contributorNames.contributorId }).from(contributorNames).where(eq(contributorNames.name, 'קריין'))
    await seedName(t.db, narrator?.id ?? '', 'Narrator Eng', 'en')
    const before = await snapshot(workId, editionId)
    const item = await readBack({ narrators: ['Narrator Eng'], series: [{ name: 'Parahumans', position: 1, positionEnd: null }] })
    await storeSourceItem(t.db, sourceId, item)
    expect(await snapshot(workId, editionId)).toEqual(before)
  })

  it('English subtitle on a Hebrew-primary book keeps the primary subtitle', async () => {
    const { sourceId, workId, editionId } = await setup('תולעת', { language: 'he' })
    await setPrimaryTitle(t.db, workId, { title: 'תולעת', subtitle: 'כותרת משנה', language: 'he' })
    await t.db.insert(workTitles).values({ workId, language: 'en', title: 'Worm', subtitle: 'An English subtitle', sortTitle: 'worm', primary: false })
    const before = await snapshot(workId, editionId)
    await storeSourceItem(t.db, sourceId, await readBack({ subtitle: 'An English subtitle' }))
    expect(await snapshot(workId, editionId)).toEqual(before)
    expect(before.work?.subtitle).toBe('כותרת משנה')
  })

  it('a real new series from ABS is still applied', async () => {
    const { sourceId, workId } = await setup('Worm', { series: { name: 'Parahumans', position: 1 } })
    await storeSourceItem(
      t.db,
      sourceId,
      await readBack({
        series: [
          { name: 'Parahumans', position: 1, positionEnd: null },
          { name: 'Other Saga', position: 2, positionEnd: null },
        ],
      }),
    )
    const rows = await t.db.select({ name: series.name, position: workSeries.position }).from(workSeries).innerJoin(series, eq(series.id, workSeries.seriesId)).where(eq(workSeries.workId, workId)).orderBy(asc(workSeries.sortIndex))
    expect(rows).toEqual([
      { name: 'Parahumans', position: 1 },
      { name: 'Other Saga', position: 2 },
    ])
  })

  it('a series named like the book but at another sequence is kept', async () => {
    const { sourceId, workId } = await setup('Worm', { volume: 5 })
    await storeSourceItem(t.db, sourceId, await readBack({ series: [{ name: 'Worm', position: 2, positionEnd: null }] }))
    const rows = await t.db.select({ name: series.name, position: workSeries.position }).from(workSeries).innerJoin(series, eq(series.id, workSeries.seriesId)).where(eq(workSeries.workId, workId))
    expect(rows).toEqual([{ name: 'Worm', position: 2 }])
  })

  it('a Hebrew-primary volume with an English title row drops the shown-title series entry', async () => {
    const { sourceId, workId, editionId } = await setup('תולעת', { language: 'he', volume: 5 })
    await t.db.insert(workTitles).values({ workId, language: 'en', title: 'Worm', subtitle: null, sortTitle: 'worm', primary: false })
    await t.db.update(editions).set({ language: 'en' }).where(eq(editions.id, editionId))
    const before = await snapshot(workId, editionId)
    const item = await readBack()
    expect(item.title).toBe('Worm, Part 5')
    expect(item.series).toEqual([{ name: 'Worm', position: 5, positionEnd: null }])
    await storeSourceItem(t.db, sourceId, item)
    expect(await snapshot(workId, editionId)).toEqual(before)
  })

  it('an existing series plus a volume entry is unchanged', async () => {
    const { sourceId, workId, editionId } = await setup('Worm', { series: { name: 'Parahumans', position: 1 }, volume: 5 })
    const before = await snapshot(workId, editionId)
    const item = await readBack()
    expect(item.series.map((s) => [s.name, s.position])).toEqual([['Parahumans', 1], ['Worm', 5]])
    await storeSourceItem(t.db, sourceId, item)
    expect(await snapshot(workId, editionId)).toEqual(before)
  })

  it('a narrator renamed in ABS and a new subtitle are still applied', async () => {
    const { sourceId, workId, editionId } = await setup('Worm', { narrators: ['Narrator One'] })
    await storeSourceItem(t.db, sourceId, await readBack({ narrators: ['Someone Else'], subtitle: 'A new subtitle' }))
    const rows = await t.db
      .select({ name: contributorNames.name })
      .from(editionContributors)
      .innerJoin(contributorNames, eq(contributorNames.id, editionContributors.nameId))
      .where(eq(editionContributors.editionId, editionId))
    expect(rows.map((r) => r.name)).toContain('Someone Else')
    expect(rows.map((r) => r.name)).not.toContain('Narrator One')
    const [work] = await t.db.select({ subtitle: works.subtitle }).from(works).where(eq(works.id, workId))
    expect(work?.subtitle).toBe('A new subtitle')
  })
})
