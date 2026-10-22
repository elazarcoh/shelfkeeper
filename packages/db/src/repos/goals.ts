import { and, desc, eq } from 'drizzle-orm'
import { goalProgress, metricTotal, notFound, type GoalInput } from '@mylib/domain'
import type { Db } from '../client'
import { goals } from '../schema'
import type { UserScope } from './scope'
import { rebuildDailyStats, summarizeStats } from './stats'

export interface GoalView {
  id: string
  periodStart: string
  periodEnd: string
  metric: (typeof goals.$inferSelect)['metric']
  target: number
  total: number
  progress: number
}

async function toView(db: Db, scope: UserScope, row: typeof goals.$inferSelect): Promise<GoalView> {
  const summary = await summarizeStats(db, scope, { from: row.periodStart, to: row.periodEnd })
  const total = metricTotal(row.metric, {
    booksFinished: summary.booksFinished,
    minutes: summary.totalMinutes,
    words: summary.totalWords,
  })
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    metric: row.metric,
    target: row.target,
    total,
    progress: goalProgress(row.target, total),
  }
}

export async function listGoals(db: Db, scope: UserScope): Promise<GoalView[]> {
  // rebuild once, then summarize every goal from the fresh daily_stat
  await rebuildDailyStats(db, scope)
  const rows = await db.select().from(goals).where(eq(goals.userId, scope.userId)).orderBy(desc(goals.periodStart))
  return Promise.all(rows.map((row) => toView(db, scope, row)))
}

export async function createGoal(db: Db, scope: UserScope, input: GoalInput): Promise<string> {
  const [row] = await db
    .insert(goals)
    .values({ userId: scope.userId, ...input })
    .returning({ id: goals.id })
  if (!row) throw new Error('goal insert failed')
  return row.id
}

export async function deleteGoal(db: Db, scope: UserScope, goalId: string): Promise<void> {
  const [row] = await db
    .delete(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, scope.userId)))
    .returning({ id: goals.id })
  if (!row) throw notFound('Goal')
}
