import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ExternalItem } from '@mylib/domain'
import { assets, editions, sourceItems, sources, userHiddenWorks } from '../schema'
import { seedUser, seedWork, useTestDb } from '../testing'
import { findVisibleAsset, listCoverSourceIds, listCoverWork, markCoverChecked, saveCover } from './covers'
import { loadUserScope } from './scope'

describe('covers repository', () => {
  const t = useTestDb()

  async function linkedWithCover(coverUrl: string | null = 'http://abs.test/api/items/li_1/cover') {
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning({ id: sources.id })
    const { workId, editionIds } = await seedWork(t.db, { title: 'The Final Empire', formats: ['audiobook'] })
    const normalized = ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'The Final Empire', coverUrl })
    const [item] = await t.db
      .insert(sourceItems)
      .values({ sourceId: source?.id ?? '', externalId: 'li_1', normalized, contentHash: 'x', state: 'linked', workId, editionId: editionIds[0] ?? null })
      .returning({ id: sourceItems.id })
    return { sourceId: source?.id ?? '', workId, editionId: editionIds[0] ?? '', sourceItemId: item?.id ?? '' }
  }

  it('lists linked copies without a cover, and saves one deduplicated by hash', async () => {
    const { sourceId, editionId, sourceItemId } = await linkedWithCover()
    const [work] = await listCoverWork(t.db, sourceId)
    expect(work).toEqual({ sourceItemId, editionId, coverUrl: 'http://abs.test/api/items/li_1/cover' })
    await saveCover(t.db, work ?? { sourceItemId, editionId, coverUrl: '' }, { path: 'covers/ab/abc.png', sha256: 'abc', mime: 'image/png' })
    await saveCover(t.db, work ?? { sourceItemId, editionId, coverUrl: '' }, { path: 'covers/ab/abc.png', sha256: 'abc', mime: 'image/png' })
    expect(await t.db.select().from(assets)).toHaveLength(1)
    expect((await t.db.select({ cover: editions.coverAssetId }).from(editions).where(eq(editions.id, editionId)))[0]?.cover).not.toBeNull()
    expect(await listCoverWork(t.db, sourceId)).toEqual([])
  })

  it('waits a week before retrying a cover that failed', async () => {
    const { sourceId, sourceItemId } = await linkedWithCover()
    await markCoverChecked(t.db, sourceItemId)
    expect(await listCoverWork(t.db, sourceId)).toEqual([])
    await t.db.update(sourceItems).set({ coverCheckedAt: new Date(Date.now() - 8 * 86_400_000) })
    expect(await listCoverWork(t.db, sourceId)).toHaveLength(1)
  })

  it('serves an asset only to someone who can see a book using it', async () => {
    const { sourceId, workId, sourceItemId, editionId } = await linkedWithCover()
    await saveCover(t.db, { sourceItemId, editionId, coverUrl: 'x' }, { path: 'covers/ab/abc.png', sha256: 'abc', mime: 'image/png' })
    const [asset] = await t.db.select({ id: assets.id }).from(assets)
    const member = await seedUser(t.db)
    expect(await findVisibleAsset(t.db, await loadUserScope(t.db, member), asset?.id ?? '')).toEqual({ path: 'covers/ab/abc.png', mime: 'image/png', sha256: 'abc' })
    await t.db.insert(userHiddenWorks).values({ userId: member.id, workId })
    expect(await findVisibleAsset(t.db, await loadUserScope(t.db, member), asset?.id ?? '')).toBeNull()
    expect(sourceId).toBeTruthy()
  })
  it('lists the sources whose copies can have a cover: synced, shelf and CSV (a linked row has a page cover)', async () => {
    const insert = async (kind: 'audiobookshelf' | 'shelf' | 'csv') => {
      const [row] = await t.db.insert(sources).values({ kind, name: kind, config: { kind }, schedule: null }).returning({ id: sources.id })
      return row?.id ?? ''
    }
    const synced = await insert('audiobookshelf')
    const shelf = await insert('shelf')
    const csv = await insert('csv')
    const ids = await listCoverSourceIds(t.db)
    expect(ids).toContain(synced)
    expect(ids).toContain(shelf)
    expect(ids).toContain(csv)
  })
})
