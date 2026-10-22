import { describe, expect, it } from 'vitest'
import { GoalInput } from '@mylib/domain'
import { seedSession, seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { createGoal, deleteGoal, listGoals } from './goals'
import { loadUserScope } from './scope'

describe('goals repository', () => {
  const t = useTestDb()

  it('creates a goal and computes its progress from finished sessions in the period', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await seedSession(t.db, {
      userId: user.id,
      workId: work,
      outcome: 'finished',
      startedOn: '2026-01-01',
      finishedOn: '2026-01-01',
      fractionCompleted: 1,
    })

    const id = await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 2 }))
    const [goal] = await listGoals(t.db, scope)
    expect(goal).toMatchObject({ id, target: 2, total: 1, progress: 0.5 })
  })

  it('reports zero progress, not an error, for a goal with no activity yet', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'hours', target: 100 }))
    const [goal] = await listGoals(t.db, scope)
    expect(goal).toMatchObject({ total: 0, progress: 0 })
  })

  it('lets a user delete only their own goal', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const id = await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 2 }))
    const other = await loadUserScope(t.db, await seedUser(t.db))
    await expect(deleteGoal(t.db, other, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await deleteGoal(t.db, scope, id)
    expect(await listGoals(t.db, scope)).toEqual([])
  })

  it('counts listening hours toward an hours goal for a session started without an edition', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'audiobook', durationSec: 36_000 }] }))
    await seedSession(t.db, {
      userId: user.id,
      workId: work,
      mode: 'listen',
      outcome: 'finished',
      startedOn: '2026-01-01',
      finishedOn: '2026-01-02',
      fractionCompleted: 1,
    })
    await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'hours', target: 20 }))
    const [goal] = await listGoals(t.db, scope)
    expect(goal).toMatchObject({ total: 10, progress: 0.5 })
  })
})
