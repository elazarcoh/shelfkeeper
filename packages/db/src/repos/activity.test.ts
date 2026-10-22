import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { userHiddenWorks, users } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { listActivity } from './activity'
import { createWork } from './catalog'
import { completeSession, startSession } from './reading-sessions'
import { loadUserScope } from './scope'
import { setRating } from './tracking'

describe('activity feed repository', () => {
  const t = useTestDb()

  it("shows a household member's session and rating activity, newest first", async () => {
    const actor = await seedUser(t.db)
    const actorScope = await loadUserScope(t.db, actor)
    const viewer = await loadUserScope(t.db, await seedUser(t.db))
    const a = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [] }))
    await setRating(t.db, actorScope, a, 4)
    const session = await startSession(t.db, actorScope, {
      workId: b,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })
    await completeSession(t.db, actorScope, session, {
      outcome: 'finished',
      finishedOn: '2026-01-02',
      finishedPrecision: 'day',
      fractionCompleted: null,
    })

    const feed = await listActivity(t.db, viewer)
    expect(feed.map((i) => i.kind)).toEqual(['finished', 'rated'])
    expect(feed.every((i) => i.actorUserId === actor.id)).toBe(true)
  })

  it('excludes activity from a user who has turned off sharing', async () => {
    const actor = await seedUser(t.db)
    await t.db.update(users).set({ shareActivity: false }).where(eq(users.id, actor.id))
    const actorScope = await loadUserScope(t.db, actor)
    const viewer = await loadUserScope(t.db, await seedUser(t.db))
    const a = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await setRating(t.db, actorScope, a, 4)

    expect(await listActivity(t.db, viewer)).toEqual([])
  })

  it('never reveals a book hidden from the viewer, even though the actor can see it', async () => {
    const actor = await seedUser(t.db)
    const actorScope = await loadUserScope(t.db, actor)
    const viewerUser = await seedUser(t.db)
    const a = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await setRating(t.db, actorScope, a, 5)
    await t.db.insert(userHiddenWorks).values({ userId: viewerUser.id, workId: a })

    const viewer = await loadUserScope(t.db, viewerUser)
    expect(await listActivity(t.db, viewer)).toEqual([])
  })
})
