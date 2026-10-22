import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { SessionOutcome } from '@mylib/domain'
import type { Db } from '../client'
import { readingSessions, userWorks, users, works } from '../schema'
import type { UserScope } from './scope'
import { shownTitleField } from './titles'

export type ActivityKind = 'started' | 'finished' | 'abandoned' | 'rated'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  actorUserId: string
  actorName: string
  workId: string
  workTitle: string
  rating: number | null
  at: Date
}

function kindForOutcome(outcome: SessionOutcome): ActivityKind {
  return outcome === 'in_progress' ? 'started' : outcome
}

/** Sessions and ratings from users who share activity, restricted to books the *viewer* (not the actor) can see. */
export async function listActivity(db: Db, scope: UserScope, limit = 30): Promise<ActivityItem[]> {
  const [sessionRows, ratingRows] = await Promise.all([
    db
      .select({
        id: readingSessions.id,
        outcome: readingSessions.outcome,
        userId: readingSessions.userId,
        actorName: users.displayName,
        workId: readingSessions.workId,
        workTitle: shownTitleField(works.id, scope.languages, 'title'),
        at: readingSessions.updatedAt,
      })
      .from(readingSessions)
      .innerJoin(users, eq(users.id, readingSessions.userId))
      .innerJoin(works, eq(works.id, readingSessions.workId))
      .where(and(eq(users.shareActivity, true), scope.visible))
      .orderBy(desc(readingSessions.updatedAt))
      .limit(limit),
    db
      .select({
        userId: userWorks.userId,
        actorName: users.displayName,
        workId: userWorks.workId,
        workTitle: shownTitleField(works.id, scope.languages, 'title'),
        rating: userWorks.rating,
        ratedAt: userWorks.ratedAt,
      })
      .from(userWorks)
      .innerJoin(users, eq(users.id, userWorks.userId))
      .innerJoin(works, eq(works.id, userWorks.workId))
      .where(and(eq(users.shareActivity, true), isNotNull(userWorks.ratedAt), scope.visible))
      .orderBy(desc(userWorks.ratedAt))
      .limit(limit),
  ])

  const sessionItems: ActivityItem[] = sessionRows.map((r) => ({
    id: `${r.id}:${r.outcome}`,
    kind: kindForOutcome(r.outcome),
    actorUserId: r.userId,
    actorName: r.actorName,
    workId: r.workId,
    workTitle: r.workTitle,
    rating: null,
    at: r.at,
  }))
  const ratingItems: ActivityItem[] = ratingRows.flatMap((r) =>
    r.ratedAt === null
      ? []
      : [
          {
            id: `${r.workId}:${r.userId}:rated`,
            kind: 'rated' as const,
            actorUserId: r.userId,
            actorName: r.actorName,
            workId: r.workId,
            workTitle: r.workTitle,
            rating: r.rating,
            at: r.ratedAt,
          },
        ],
  )

  return [...sessionItems, ...ratingItems].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
}
