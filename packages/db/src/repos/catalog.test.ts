import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { EditionInput, ExternalItem } from '@mylib/domain'
import { contributorNames, contributors, editions, readingSessions, series, seriesNames, setItems, sourceItems, sources, userHiddenWorks, users, workSearch, workSeries, workTitles } from '../schema'
import { seedSession, seedUser, useTestDb, waitFor, workInput } from '../testing'
import {
  addEdition,
  changeHolding,
  createWork,
  deleteEdition,
  deleteWork,
  getWorkDetail,
  splitEdition,
  updateEdition,
  updateWork,
} from './catalog'
import { loadUserScope } from './scope'
import { addWorkToSet, getDefaultPersonalSetId } from './sets'
import { setStatus } from './tracking'

describe('catalog repository', () => {
  const t = useTestDb()
  const member = async () => loadUserScope(t.db, await seedUser(t.db))

  it('two people see one book page in their own language, editions included', async () => {
    const id = await createWork(t.db, workInput({ title: 'קצב המלחמה', authors: ['ברנדון סנדרסון'], series: [{ name: 'גנזך אורות הסער', position: 4 }], editions: [{ format: 'physical', language: 'he' }, { format: 'ebook', language: 'en' }] }))
    await t.db.insert(workTitles).values({ workId: id, language: 'en', title: 'Rhythm of War', sortTitle: 'rhythm of war', primary: false })
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    await t.db.insert(contributorNames).values({ contributorId: person?.id ?? '', name: 'Brandon Sanderson', normalizedName: 'brandon sanderson', language: 'en' })
    await t.db.update(contributorNames).set({ language: 'he' }).where(eq(contributorNames.name, 'ברנדון סנדרסון'))
    const [s] = await t.db.select({ id: series.id }).from(series)
    await t.db.insert(seriesNames).values({ seriesId: s?.id ?? '', name: 'Stormlight Archive', normalizedName: 'stormlight archive', language: 'en' })
    const as = async (titleLanguages: string[]) => {
      const user = await seedUser(t.db)
      await t.db.update(users).set({ titleLanguages }).where(eq(users.id, user.id))
      return getWorkDetail(t.db, await loadUserScope(t.db, user), id)
    }
    const en = await as(['en', 'he'])
    expect(en).toMatchObject({ title: 'Rhythm of War', subtitle: null, authors: [{ name: 'Brandon Sanderson' }], series: [{ name: 'Stormlight Archive' }] })
    const he = await as(['he', 'en'])
    expect(he).toMatchObject({ title: 'קצב המלחמה', authors: [{ name: 'ברנדון סנדרסון' }], series: [{ name: 'גנזך אורות הסער' }] })
    expect(en).toMatchObject({ primaryTitle: 'קצב המלחמה', primarySubtitle: null, authors: [{ creditedName: 'ברנדון סנדרסון' }] })
    expect(he).toMatchObject({ primaryTitle: 'קצב המלחמה', authors: [{ creditedName: 'ברנדון סנדרסון' }] })
    // the edition level is the same for both: its own title, else the title in its language
    for (const detail of [en, he]) {
      expect(detail.editions.map((e) => [e.language, e.displayTitle])).toEqual([['he', 'קצב המלחמה'], ['en', 'Rhythm of War']])
    }
  })

  it("shows each edition's live sources to anyone who can see the book", async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput({ editions: [{ format: 'physical' }, { format: 'audiobook' }] }))
    const [physical, audiobook] = (await getWorkDetail(t.db, scope, id)).editions
    const [home] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'Home ABS', config: { kind: 'audiobookshelf' } }).returning()
    const [old] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'Old ABS', config: { kind: 'audiobookshelf' } }).returning()
    const normalized = ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'The Final Empire' })
    const item = (sourceId: string, externalId: string, removedAt: Date | null = null) =>
      ({ sourceId, externalId, normalized, contentHash: 'h', editionId: audiobook?.id ?? null, workId: id, state: 'linked' as const, removedAt })
    await t.db.insert(sourceItems).values([item(home?.id ?? '', 'li_1'), item(home?.id ?? '', 'li_2'), item(old?.id ?? '', 'li_1', new Date())])

    const detail = await getWorkDetail(t.db, scope, id)
    expect(detail.editions.find((e) => e.id === physical?.id)?.sources).toEqual([])
    expect(detail.editions.find((e) => e.id === audiobook?.id)?.sources).toEqual([{ name: 'Home ABS', kind: 'audiobookshelf' }])
  })

  it('creates a work with relations and returns its detail', async () => {
    const scope = await member()
    const id = await createWork(
      t.db,
      workInput({
        subtitle: 'Mistborn Book One',
        tags: ['Epic Fantasy', 'epic fantasy'],
        editions: [
          { format: 'physical', isbn13: '9780765311788', shelfLocation: 'Living room' },
          { format: 'audiobook', durationSec: 86_400, narrators: ['Michael Kramer'] },
        ],
      }),
    )
    const w = await getWorkDetail(t.db, scope, id)
    expect(w.title).toBe('The Final Empire')
    expect(w.authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
    expect(w.series.map((s) => [s.name, s.position])).toEqual([['Mistborn', 1]])
    expect(w.tags.map((tag) => tag.name)).toEqual(['Epic Fantasy'])
    expect(w.editions.map((e) => e.format)).toEqual(['physical', 'audiobook'])
    expect(w.editions[1]?.narrators.map((n) => n.name)).toEqual(['Michael Kramer'])
    expect(w.me).toEqual({ status: 'none', rating: null, review: null, inQueue: false })
    expect(w.provenance.title).toMatchObject({ origin: 'manual', locked: true })
    expect(w.editions[0]?.provenance.shelfLocation).toMatchObject({ origin: 'manual', locked: true })
    expect(w.editions[0]?.provenance.pageCount).toBeUndefined()
    expect(w.availability).toBe('owned')
    expect(w.editions[0]).toMatchObject({ ownership: 'owned', inPossession: true })
    expect(w.editions[0]?.history.map((h) => [h.type, h.origin])).toEqual([['acquired', 'manual']])
  })

  it('tracks a borrowed book through return, purchase, loss and recovery', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const id = await createWork(
      t.db,
      workInput({ editions: [{ format: 'physical', ownership: 'borrowed', holdingOn: '2026-01-10', holdingNote: 'City library' }] }),
      user.id,
    )
    const edition = async () => (await getWorkDetail(t.db, scope, id)).editions[0]
    const editionId = (await edition())?.id ?? ''
    expect((await getWorkDetail(t.db, scope, id)).availability).toBe('borrowed')
    expect((await edition())?.history[0]).toMatchObject({ type: 'borrowed', occurredOn: '2026-01-10', note: 'City library', actorName: user.displayName })

    await changeHolding(t.db, scope, editionId, { action: 'returned', on: '2026-02-01', note: null })
    expect((await getWorkDetail(t.db, scope, id)).availability).toBe('not_owned')
    await expect(changeHolding(t.db, scope, editionId, { action: 'no_longer_have', on: '2026-02-15', note: null })).rejects.toMatchObject({
      code: 'INVALID',
    })

    await changeHolding(t.db, scope, editionId, { action: 'bought', on: '2026-03-01', note: 'Bookshop' })
    expect((await getWorkDetail(t.db, scope, id)).availability).toBe('owned')
    await changeHolding(t.db, scope, editionId, { action: 'no_longer_have', on: '2026-04-01', note: 'Lent and lost' })
    const gone = await getWorkDetail(t.db, scope, id)
    expect(gone.availability).toBe('formerly_owned')
    expect(gone.title).toBe('The Final Empire')

    await changeHolding(t.db, scope, editionId, { action: 'got_back', on: '2026-05-01', note: null })
    expect((await getWorkDetail(t.db, scope, id)).availability).toBe('owned')
    expect((await edition())?.history.map((h) => h.type)).toEqual(['restored', 'removed', 'acquired', 'returned', 'borrowed'])
  })

  it('reuses contributors across works regardless of case and accents', async () => {
    await createWork(t.db, workInput({ authors: ['Brandon Sanderson'] }))
    await createWork(t.db, workInput({ title: 'Elantris', authors: ['brandon  SANDERSON'], series: [] }))
    const rows = await t.db.select().from(contributors)
    expect(rows).toHaveLength(1)
  })

  it('patches only the given fields, locks them and refreshes search', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput())
    await updateWork(t.db, scope, id, { title: 'Mistborn', authors: ['Brandon Sanderson', 'Isaac Stewart'] })
    const w = await getWorkDetail(t.db, scope, id)
    expect(w.title).toBe('Mistborn')
    expect(w.series.map((s) => s.name)).toEqual(['Mistborn'])
    expect(w.authors.map((a) => a.name)).toEqual(['Brandon Sanderson', 'Isaac Stewart'])
    const [doc] = await t.db.select().from(workSearch).where(eq(workSearch.workId, id))
    expect(doc?.authorText).toBe('brandon sanderson isaac stewart')
    expect(doc?.titleText).toBe('mistborn')
  })

  it('adds and updates editions; only admins delete them, never the last one', async () => {
    const scope = await member()
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const id = await createWork(t.db, workInput())
    const audioId = await addEdition(t.db, scope, id, EditionInput.parse({ format: 'audiobook' }))
    await updateEdition(t.db, scope, audioId, { durationSec: 3600, narrators: ['Michael Kramer'] })
    let w = await getWorkDetail(t.db, scope, id)
    const audio = w.editions.find((e) => e.id === audioId)
    expect(audio?.durationSec).toBe(3600)
    expect(audio?.narrators.map((n) => n.name)).toEqual(['Michael Kramer'])
    expect(audio?.provenance.durationSec).toMatchObject({ origin: 'manual', locked: true })

    await expect(deleteEdition(t.db, scope, audioId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await deleteEdition(t.db, admin, audioId)
    w = await getWorkDetail(t.db, scope, id)
    expect(w.editions).toHaveLength(1)
    const onlyId = w.editions[0]?.id ?? ''
    await expect(deleteEdition(t.db, admin, onlyId)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('splits an edition into a new work with the same metadata', async () => {
    const scope = await member()
    const id = await createWork(
      t.db,
      workInput({ tags: ['Fantasy'], editions: [{ format: 'physical' }, { format: 'ebook', title: 'Mistborn (ebook)' }] }),
    )
    const before = await getWorkDetail(t.db, scope, id)
    const ebookId = before.editions.find((e) => e.format === 'ebook')?.id ?? ''
    const newId = await splitEdition(t.db, scope, ebookId)
    const [original, split] = await Promise.all([getWorkDetail(t.db, scope, id), getWorkDetail(t.db, scope, newId)])
    expect(original.editions.map((e) => e.format)).toEqual(['physical'])
    expect(split.editions.map((e) => e.id)).toEqual([ebookId])
    expect(split.title).toBe('The Final Empire')
    expect(split.authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
    expect(split.tags.map((tag) => tag.name)).toEqual(['Fantasy'])
    await expect(splitEdition(t.db, scope, ebookId)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it("moves the split edition's reading sessions to the new work", async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const id = await createWork(t.db, workInput({ editions: [{ format: 'physical' }, { format: 'audiobook' }] }))
    const editionsBefore = (await getWorkDetail(t.db, scope, id)).editions
    const audioId = editionsBefore.find((e) => e.format === 'audiobook')?.id ?? ''
    const physicalId = editionsBefore.find((e) => e.format === 'physical')?.id ?? ''
    const onAudio = await seedSession(t.db, { userId: user.id, workId: id, editionId: audioId, mode: 'listen', startedOn: '2026-01-01' })
    const onPhysical = await seedSession(t.db, { userId: user.id, workId: id, editionId: physicalId, startedOn: '2026-01-01' })
    const newId = await splitEdition(t.db, scope, audioId)
    const rows = await t.db
      .select({ id: readingSessions.id, workId: readingSessions.workId })
      .from(readingSessions)
      .where(eq(readingSessions.userId, user.id))
    expect(rows.find((r) => r.id === onAudio)?.workId).toBe(newId)
    expect(rows.find((r) => r.id === onPhysical)?.workId).toBe(id)
  })

  it('splitting an edition carries each user\'s status and rating to the new book', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ title: 'Dune', series: [], editions: [{ format: 'physical' }, { format: 'audiobook' }] }))
    await setStatus(t.db, scope, workId, 'read')
    const audiobook = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.format === 'audiobook')
    const newWorkId = await splitEdition(t.db, scope, audiobook?.id ?? '')
    expect((await getWorkDetail(t.db, scope, newWorkId)).me.status).toBe('read')
  })

  it('keeps per-user hiding and set membership when splitting an edition', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const adminScope = await loadUserScope(t.db, admin)
    const kid = await seedUser(t.db)
    const id = await createWork(t.db, workInput({ editions: [{ format: 'physical' }, { format: 'ebook' }] }))
    const mySet = await getDefaultPersonalSetId(t.db, admin.id)
    await addWorkToSet(t.db, adminScope, mySet, id)
    await t.db.insert(userHiddenWorks).values({ userId: kid.id, workId: id, hiddenBy: admin.id })
    const ebookId = (await getWorkDetail(t.db, adminScope, id)).editions.find((e) => e.format === 'ebook')?.id ?? ''

    const newId = await splitEdition(t.db, adminScope, ebookId)

    const kidScope = await loadUserScope(t.db, kid)
    await expect(getWorkDetail(t.db, kidScope, newId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const hidden = await t.db.select().from(userHiddenWorks).where(eq(userHiddenWorks.workId, newId))
    expect(hidden).toMatchObject([{ userId: kid.id, hiddenBy: admin.id }])
    const items = await t.db.select().from(setItems).where(eq(setItems.workId, newId))
    expect(items.map((i) => i.setId)).toEqual([mySet])
  })

  it('treats hidden works as missing for every operation', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const id = await createWork(t.db, workInput())
    const editionId = (await getWorkDetail(t.db, scope, id)).editions[0]?.id ?? ''
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: id })
    await expect(getWorkDetail(t.db, scope, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(updateWork(t.db, scope, id, { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(addEdition(t.db, scope, id, EditionInput.parse({ format: 'ebook' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(updateEdition(t.db, scope, editionId, { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      changeHolding(t.db, scope, editionId, { action: 'no_longer_have', on: '2026-01-01', note: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets only admins delete works', async () => {
    const id = await createWork(t.db, workInput())
    await expect(deleteWork(t.db, await member(), id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    await deleteWork(t.db, admin, id)
    await expect(getWorkDetail(t.db, admin, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deletes a work taking an edition before its sessions, like add-with-length, so the two cannot deadlock (#6)', async () => {
    const user = await seedUser(t.db, { role: 'admin' })
    const admin = await loadUserScope(t.db, user)
    const id = await createWork(t.db, workInput())
    const editionId = (await getWorkDetail(t.db, admin, id)).editions[0]?.id ?? ''
    const sessionId = await seedSession(t.db, { userId: user.id, workId: id, editionId, startedOn: '2026-01-01' })

    // add-with-length's first step: the edition's length saved, the session not locked yet
    let release = (): void => undefined
    let locked = (): void => undefined
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = t.db.transaction(async (tx) => {
      await tx.update(editions).set({ pageCount: 300 }).where(eq(editions.id, editionId))
      locked()
      await new Promise<void>((resolve) => (release = resolve))
    })
    await isLocked
    const deleting = deleteWork(t.db, admin, id)
    try {
      await waitFor(async () => {
        const [row] = await t.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "edition"%for update%'`,
        )
        return (row?.n ?? 0) > 0
      }, 'deleteWork to wait for the edition')

      // while it waits for the edition it holds no session lock, so add-with-length's next step goes through
      await t.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`)
        await tx.select({ id: readingSessions.id }).from(readingSessions).where(eq(readingSessions.id, sessionId)).for('update')
      })
    } finally {
      release()
      await holder
      await deleting
    }
    expect(await t.db.select().from(readingSessions).where(eq(readingSessions.id, sessionId))).toEqual([])
  })

  it('new authors take the first edition language; editing authors later uses it too (#124)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const id = await createWork(t.db, workInput({ title: 'Dual', authors: ['First Person'], series: [], editions: [{ format: 'physical' }, { format: 'ebook', language: 'he' }] }))
    const tagOf = async (name: string) => (await t.db.select({ language: contributorNames.language }).from(contributorNames).where(eq(contributorNames.name, name)))[0]?.language
    expect(await tagOf('First Person')).toBe('he')
    await updateWork(t.db, scope, id, { authors: ['First Person', 'Second Person'] })
    expect(await tagOf('Second Person')).toBe('he')
    expect('language' in (await getWorkDetail(t.db, scope, id))).toBe(false)
  })

  it('a split-off book names new authors in the split edition language (#124)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const id = await createWork(t.db, workInput({ title: 'Two', authors: ['Split Author'], series: [], editions: [{ format: 'physical', language: 'en' }, { format: 'ebook', language: 'he' }] }))
    const ebook = (await getWorkDetail(t.db, scope, id)).editions.find((e) => e.format === 'ebook')?.id ?? ''
    const newId = await splitEdition(t.db, scope, ebook)
    const detail = await getWorkDetail(t.db, scope, newId)
    expect(detail.authors.map((a) => a.name)).toEqual(['Split Author'])
    expect(detail.editions.map((e) => e.language)).toEqual(['he'])
  })
})

describe('series ranges (#122)', () => {
  const t = useTestDb()
  it('round-trips a range, and a single position keeps a null end', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const id = await createWork(t.db, workInput({ title: 'Publisher’s Pack', series: [{ name: 'Mage Errant', position: 1, positionEnd: 2 }, { name: 'Cosmere', position: 3 }] }))
    expect((await getWorkDetail(t.db, scope, id)).series).toMatchObject([
      { name: 'Mage Errant', position: 1, positionEnd: 2 },
      { name: 'Cosmere', position: 3, positionEnd: null },
    ])
  })
  it('the database refuses a range that does not go up', async () => {
    const id = await createWork(t.db, workInput({ title: 'One', series: [{ name: 'S', position: 1 }] }))
    const error: unknown = await t.db
      .update(workSeries)
      .set({ positionEnd: 1 })
      .where(eq(workSeries.workId, id))
      .then(
        () => null,
        (e: unknown) => e,
      )
    // drizzle wraps the driver's error: the constraint is named in its cause
    expect(String((error as { cause?: unknown } | null)?.cause)).toMatch(/work_series_position_end_check/)
  })
})
