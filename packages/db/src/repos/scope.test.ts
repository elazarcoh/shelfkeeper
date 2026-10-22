import { describe, expect, it } from 'vitest'
import { queueEntries, setItems, sets, userHiddenSets, userHiddenWorks, userSets, userWorks } from '../schema'
import { libraryTitles, seedUser, seedWork, useTestDb, visibleTitles } from '../testing'
import type { Db } from '../client'
import { assertVisibleWork, loadUserScope, requireAdmin } from './scope'
import { updateUser } from './users'
import type { FilterNode } from '@mylib/domain'

async function globalSet(db: Db, name: string, filter?: FilterNode) {
  const [row] = await db
    .insert(sets)
    .values({ name, scope: 'global', kind: filter ? 'smart' : 'manual', filter: filter ?? null })
    .returning({ id: sets.id })
  if (!row) throw new Error('set insert failed')
  return row.id
}

describe('loadUserScope', () => {
  const t = useTestDb()

  it('carries the title language order, English then Hebrew by default', async () => {
    const user = await seedUser(t.db)
    expect((await loadUserScope(t.db, user)).languages).toEqual(['en', 'he'])
    await updateUser(t.db, user.id, { titleLanguages: ['Hebrew', 'en'] })
    expect((await loadUserScope(t.db, user)).languages).toEqual(['he', 'en'])
  })

  it('shows every work when nothing is hidden', async () => {
    const user = await seedUser(t.db)
    await seedWork(t.db, { title: 'A' })
    await seedWork(t.db, { title: 'B' })
    expect(await visibleTitles(t.db, await loadUserScope(t.db, user))).toEqual(['A', 'B'])
  })

  it('hides works hidden directly, only for that user', async () => {
    const kid = await seedUser(t.db)
    const parent = await seedUser(t.db)
    const a = await seedWork(t.db, { title: 'A' })
    await seedWork(t.db, { title: 'B' })
    await t.db.insert(userHiddenWorks).values({ userId: kid.id, workId: a.workId })
    expect(await visibleTitles(t.db, await loadUserScope(t.db, kid))).toEqual(['B'])
    expect(await visibleTitles(t.db, await loadUserScope(t.db, parent))).toEqual(['A', 'B'])
  })

  it('hides items of a hidden manual set', async () => {
    const kid = await seedUser(t.db)
    const a = await seedWork(t.db, { title: 'A' })
    await seedWork(t.db, { title: 'B' })
    const setId = await globalSet(t.db, 'Adults')
    await t.db.insert(setItems).values({ setId, workId: a.workId })
    await t.db.insert(userHiddenSets).values({ userId: kid.id, setId })
    expect(await visibleTitles(t.db, await loadUserScope(t.db, kid))).toEqual(['B'])
  })

  it('hides current and future matches of a hidden smart set', async () => {
    const kid = await seedUser(t.db)
    const adult = await seedWork(t.db, { title: 'A', tags: ['adult'] })
    await seedWork(t.db, { title: 'B' })
    const setId = await globalSet(t.db, 'Adult', { op: 'tag', tagIds: adult.tagIds })
    await t.db.insert(userHiddenSets).values({ userId: kid.id, setId })
    await seedWork(t.db, { title: 'C', tags: ['Adult'] })
    expect(await visibleTitles(t.db, await loadUserScope(t.db, kid))).toEqual(['B'])
  })

  it('does not hide works whose language is unknown through a hidden language set', async () => {
    const kid = await seedUser(t.db)
    await seedWork(t.db, { title: 'French', language: 'fr' })
    await seedWork(t.db, { title: 'Unknown', language: null })
    const setId = await globalSet(t.db, 'French', { op: 'language', languages: ['fr'] })
    await t.db.insert(userHiddenSets).values({ userId: kid.id, setId })
    expect(await visibleTitles(t.db, await loadUserScope(t.db, kid))).toEqual(['Unknown'])
  })

  it('builds the personal library from active sets, activity and the queue', async () => {
    const user = await seedUser(t.db)
    const scope0 = await loadUserScope(t.db, user)
    expect(await libraryTitles(t.db, scope0)).toEqual([])

    const inMyBooks = await seedWork(t.db, { title: 'Mine' })
    const inGlobal = await seedWork(t.db, { title: 'Global' })
    const audio = await seedWork(t.db, { title: 'Audio', formats: ['audiobook'] })
    const rated = await seedWork(t.db, { title: 'Rated' })
    const queued = await seedWork(t.db, { title: 'Queued' })
    await seedWork(t.db, { title: 'Elsewhere' })

    const [myBooks] = await t.db.select({ id: sets.id }).from(sets)
    await t.db.insert(setItems).values({ setId: myBooks?.id ?? '', workId: inMyBooks.workId })
    const globalId = await globalSet(t.db, 'Shelf')
    await t.db.insert(setItems).values({ setId: globalId, workId: inGlobal.workId })
    await t.db.insert(userSets).values({ userId: user.id, setId: globalId, active: true })
    const smartId = await globalSet(t.db, 'Audiobooks', { op: 'format', formats: ['audiobook'] })
    await t.db.insert(userSets).values({ userId: user.id, setId: smartId, active: true })
    await t.db.insert(userWorks).values({ userId: user.id, workId: rated.workId, rating: 3 })
    await t.db.insert(queueEntries).values({ userId: user.id, workId: queued.workId, position: 1 })
    expect(audio.editionIds).toHaveLength(1)

    const scope = await loadUserScope(t.db, user)
    expect(await libraryTitles(t.db, scope)).toEqual(['Audio', 'Global', 'Mine', 'Queued', 'Rated'])
  })

  it('drops inactive sets and hidden works from the library', async () => {
    const user = await seedUser(t.db)
    const w = await seedWork(t.db, { title: 'Shelf book' })
    const globalId = await globalSet(t.db, 'Shelf')
    await t.db.insert(setItems).values({ setId: globalId, workId: w.workId })
    await t.db.insert(userSets).values({ userId: user.id, setId: globalId, active: false })
    expect(await libraryTitles(t.db, await loadUserScope(t.db, user))).toEqual([])

    await t.db.insert(userWorks).values({ userId: user.id, workId: w.workId, status: 'reading' })
    expect(await libraryTitles(t.db, await loadUserScope(t.db, user))).toEqual(['Shelf book'])
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: w.workId })
    expect(await libraryTitles(t.db, await loadUserScope(t.db, user))).toEqual([])
  })

  it('assertVisibleWork answers NOT_FOUND for hidden and missing works', async () => {
    const user = await seedUser(t.db)
    const w = await seedWork(t.db, { title: 'Secret' })
    await expect(assertVisibleWork(t.db, await loadUserScope(t.db, user), w.workId)).resolves.toBeUndefined()
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: w.workId })
    const scope = await loadUserScope(t.db, user)
    await expect(assertVisibleWork(t.db, scope, w.workId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(assertVisibleWork(t.db, scope, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('requireAdmin rejects members', async () => {
    const member = await seedUser(t.db)
    const admin = await seedUser(t.db, { role: 'admin' })
    const memberScope = await loadUserScope(t.db, member)
    const adminScope = await loadUserScope(t.db, admin)
    expect(() => { requireAdmin(memberScope) }).toThrow('Admins only')
    expect(() => { requireAdmin(adminScope) }).not.toThrow()
  })
})
