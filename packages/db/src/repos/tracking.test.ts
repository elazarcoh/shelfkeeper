import { describe, expect, it } from 'vitest'
import { userHiddenWorks } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { loadUserScope } from './scope'
import {
  addToQueue,
  listQueueIds,
  removeFromQueue,
  reorderQueue,
  restoreToQueue,
  setRating,
  setReview,
  setStatus,
} from './tracking'

describe('tracking repository', () => {
  const t = useTestDb()

  async function setup() {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const a = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [] }))
    const c = await createWork(t.db, workInput({ title: 'C', series: [] }))
    return { user, scope, a, b, c }
  }

  it('stores status, rating and review per user', async () => {
    const { scope, a } = await setup()
    await setStatus(t.db, scope, a, 'reading')
    await setRating(t.db, scope, a, 4.5)
    await setReview(t.db, scope, a, 'Loved the heist.')
    expect((await getWorkDetail(t.db, scope, a)).me).toEqual({
      status: 'reading',
      rating: 4.5,
      review: 'Loved the heist.',
      inQueue: false,
    })
    await setRating(t.db, scope, a, null)
    expect((await getWorkDetail(t.db, scope, a)).me.rating).toBeNull()
    const other = await loadUserScope(t.db, await seedUser(t.db))
    expect((await getWorkDetail(t.db, other, a)).me.status).toBe('none')
  })

  it('rejects ratings that are not half steps at the database level', async () => {
    const { scope, a } = await setup()
    await expect(setRating(t.db, scope, a, 4.3)).rejects.toThrow()
  })

  it('adds to the top or bottom and moves when re-added', async () => {
    const { scope, a, b, c } = await setup()
    await addToQueue(t.db, scope, a, 'bottom')
    await addToQueue(t.db, scope, b, 'bottom')
    await addToQueue(t.db, scope, c, 'top')
    expect(await listQueueIds(t.db, scope)).toEqual([c, a, b])
    await addToQueue(t.db, scope, b, 'top')
    expect(await listQueueIds(t.db, scope)).toEqual([b, c, a])
    await removeFromQueue(t.db, scope, c)
    expect(await listQueueIds(t.db, scope)).toEqual([b, a])
  })

  it('reorders only with an exact permutation of the queue', async () => {
    const { scope, a, b, c } = await setup()
    for (const id of [a, b, c]) await addToQueue(t.db, scope, id, 'bottom')
    await reorderQueue(t.db, scope, [c, b, a])
    expect(await listQueueIds(t.db, scope)).toEqual([c, b, a])
    await expect(reorderQueue(t.db, scope, [a, b])).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(reorderQueue(t.db, scope, [a, a, b])).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('treats hidden works as missing', async () => {
    const { user, a, b } = await setup()
    const before = await loadUserScope(t.db, user)
    await addToQueue(t.db, before, b, 'bottom')
    await t.db.insert(userHiddenWorks).values([
      { userId: user.id, workId: a },
      { userId: user.id, workId: b },
    ])
    const scope = await loadUserScope(t.db, user)
    await expect(setStatus(t.db, scope, a, 'read')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setRating(t.db, scope, a, 5)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(addToQueue(t.db, scope, a, 'top')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await listQueueIds(t.db, scope)).toEqual([])
  })

  it('restores a book to the Up next position it had (#85 Undo)', async () => {
    const { scope, a, b, c } = await setup()
    for (const w of [a, b, c]) await addToQueue(t.db, scope, w, 'bottom')
    await removeFromQueue(t.db, scope, b)
    await restoreToQueue(t.db, scope, b, 2)
    expect(await listQueueIds(t.db, scope)).toEqual([a, b, c])
    // restoring a book already in Up next moves it rather than adding it twice
    await restoreToQueue(t.db, scope, b, 4)
    expect(await listQueueIds(t.db, scope)).toEqual([a, c, b])
  })
})
