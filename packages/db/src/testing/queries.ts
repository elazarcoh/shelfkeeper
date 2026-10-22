import { asc, type SQL } from 'drizzle-orm'
import type { Db } from '../client'
import type { UserScope } from '../repos/scope'
import { works } from '../schema'

export async function titlesWhere(db: Db, where: SQL): Promise<string[]> {
  const rows = await db.select({ title: works.title }).from(works).where(where).orderBy(asc(works.title))
  return rows.map((r) => r.title)
}

export const visibleTitles = (db: Db, scope: UserScope) => titlesWhere(db, scope.visible)
export const libraryTitles = (db: Db, scope: UserScope) => titlesWhere(db, scope.inLibrary)
