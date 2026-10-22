import { asc, eq, inArray, sql } from 'drizzle-orm'
import {
  DomainError,
  markManual,
  MergeVolumesInput,
  planSessionFusion,
  statusAfterCompletion,
  volumeFromTitles,
  type FusionSession,
  type VolumeCatalogEntry,
} from '@mylib/domain'
import type { Db } from '../client'
import { editions, readingProgress, readingSessions, series, userWorks, users, workContributors, workSeries, works } from '../schema'
import { lockForMerge, moveIntoTarget, syncVolumeCount } from './catalog'
import { requireAdmin, loadUserScope, type UserScope } from './scope'
import { shownBookName } from './person-names'
import { refreshSearchDocument } from './search-index'
import { rebuildDailyStats } from './stats'
import { setPrimaryTitle } from './titles'

/** Every visible book with what the Admin → Volumes cleanup needs to spot volumes of one book. Admins only. */
export async function listVolumeCatalog(db: Db, scope: UserScope): Promise<VolumeCatalogEntry[]> {
  requireAdmin(scope)
  const rows = await db
    .select({ id: works.id, title: works.title, subtitle: works.subtitle })
    .from(works)
    .where(scope.visible)
    .orderBy(asc(works.sortTitle), asc(works.id))
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return []
  const [authorRows, seriesRows, editionRows] = await Promise.all([
    db
      .select({ workId: workContributors.workId, name: shownBookName(workContributors.nameId, workContributors.contributorId, workContributors.workId) })
      .from(workContributors)
      .where(inArray(workContributors.workId, ids))
      .orderBy(asc(workContributors.position)),
    db
      .select({ workId: workSeries.workId, name: series.name, position: workSeries.position })
      .from(workSeries)
      .innerJoin(series, eq(series.id, workSeries.seriesId))
      .where(inArray(workSeries.workId, ids))
      .orderBy(asc(workSeries.sortIndex)),
    db
      .select({
        id: editions.id,
        workId: editions.workId,
        format: editions.format,
        language: editions.language,
        isbn13: editions.isbn13,
        isbn10: editions.isbn10,
        volume: editions.volume,
        volumeCount: editions.volumeCount,
      })
      .from(editions)
      .where(inArray(editions.workId, ids))
      .orderBy(asc(editions.volume), asc(editions.id)),
  ])
  const group = <T extends { workId: string }>(list: T[]) => {
    const map = new Map<string, T[]>()
    for (const item of list) map.set(item.workId, [...(map.get(item.workId) ?? []), item])
    return map
  }
  const authors = group(authorRows)
  const seriesOf = group(seriesRows)
  const editionsOf = group(editionRows)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    authors: (authors.get(r.id) ?? []).map((a) => a.name),
    series: (seriesOf.get(r.id) ?? []).map((s) => ({ name: s.name, position: s.position })),
    editions: (editionsOf.get(r.id) ?? []).map((e) => ({
      id: e.id,
      format: e.format,
      language: e.language,
      isbn: e.isbn13 ?? e.isbn10,
      volume: e.volume,
      volumeCount: e.volumeCount,
    })),
  }))
}

export interface MergeVolumesResult {
  workId: string
  /** what lost a conflict in the underlying merge */
  dropped: string[]
  /** one line per read that was joined from per-volume reads */
  fused: string[]
}

/** Editions are one volume set when they share a format and a language. */
const setKeyOf = (e: { format: string; language: string | null }): string => `${e.format}|${(e.language ?? '').trim().toLowerCase()}`

/**
 * Merges books that are volumes of one book into the survivor (#66): their editions get the volume numbers, the
 * title becomes the book's, and each person's per-volume reads become one read. Admins only; all or nothing.
 */
export async function mergeAsVolumes(db: Db, scope: UserScope, rawInput: MergeVolumesInput): Promise<MergeVolumesResult> {
  requireAdmin(scope)
  const input = MergeVolumesInput.parse(rawInput)
  const { survivorId, title, volumeCount } = input
  const others = input.members.map((m) => m.workId).filter((id) => id !== survivorId)
  const allIds = [survivorId, ...others]
  const memberVolume = new Map(input.members.map((m) => [m.workId, m.volume]))

  return db.transaction(async (tx) => {
    await lockForMerge(tx, allIds)
    const memberEditions = await tx.select({ id: editions.id, workId: editions.workId }).from(editions).where(inArray(editions.workId, allIds))
    const memberSessions = await tx.select({ id: readingSessions.id, workId: readingSessions.workId, userId: readingSessions.userId }).from(readingSessions).where(inArray(readingSessions.workId, allIds))
    const sessionMemberVolume = new Map(memberSessions.map((s) => [s.id, memberVolume.get(s.workId) ?? null]))
    const [before] = await tx.select({ title: works.title, subtitle: works.subtitle, provenance: works.provenance }).from(works).where(eq(works.id, survivorId))
    if (!before) throw new DomainError('NOT_FOUND', 'Book not found')

    // in a volume merge the members' differing titles are expected, not a loss
    const dropped = (await moveIntoTarget(tx, scope, survivorId, others)).filter((line) => !line.startsWith('Title “'))

    // a member's volume goes on its editions that have none; an edition's own volume stays
    const filled: string[] = []
    for (const m of input.members) {
      if (m.volume === null) continue
      const ids = memberEditions.filter((e) => e.workId === m.workId).map((e) => e.id)
      if (ids.length === 0) continue
      const set = await tx
        .update(editions)
        .set({ volume: m.volume })
        .where(sql`${inArray(editions.id, ids)} and ${editions.volume} is null`)
        .returning({ id: editions.id })
      filled.push(...set.map((r) => r.id))
    }

    const survivorEditions = await tx
      .select({ id: editions.id, volume: editions.volume, format: editions.format, language: editions.language })
      .from(editions)
      .where(eq(editions.workId, survivorId))
    const highest = survivorEditions.reduce<number | null>((max, e) => (e.volume !== null && (max === null || e.volume > max) ? e.volume : max), null)
    if (volumeCount !== null) {
      // only the volume sets this merge touched get the count; the survivor's other sets keep theirs
      const touched = new Set([...memberEditions.filter((e) => e.workId !== survivorId).map((e) => e.id), ...filled])
      const touchedSets = new Set(survivorEditions.filter((e) => touched.has(e.id) && e.volume !== null).map(setKeyOf))
      for (const key of touchedSets) {
        const inSet = survivorEditions.filter((e) => e.volume !== null && setKeyOf(e) === key)
        const top = Math.max(...inSet.map((e) => e.volume ?? 0))
        if (top > volumeCount) throw new DomainError('INVALID', `Volume ${top} is in the catalog, so the number of volumes can't be lower`)
        await tx.update(editions).set({ volumeCount }).where(inArray(editions.id, inSet.map((e) => e.id)))
      }
    } else {
      for (const id of filled) await syncVolumeCount(tx, survivorId, id)
    }

    const cleaned = volumeFromTitles(before.title, before.subtitle)
    const subtitleChanged = cleaned.subtitle !== before.subtitle
    await setPrimaryTitle(tx, survivorId, { title, subtitle: subtitleChanged ? cleaned.subtitle : before.subtitle })
    await tx
      .update(works)
      .set({ provenance: markManual(before.provenance, subtitleChanged ? ['title', 'subtitle'] : ['title'], new Date()) })
      .where(eq(works.id, survivorId))
    await refreshSearchDocument(tx, survivorId)

    const editionVolume = new Map(survivorEditions.map((e) => [e.id, e.volume]))
    const editionSet = new Map(survivorEditions.map((e) => [e.id, setKeyOf(e)]))
    const sessionOrigin = new Map(memberSessions.map((s) => [s.id, s.workId]))
    const sessions = await tx.select().from(readingSessions).where(eq(readingSessions.workId, survivorId))
    const fusionSessions: FusionSession[] = sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      mode: s.mode,
      volume: sessionMemberVolume.get(s.id) ?? (s.editionId === null ? null : (editionVolume.get(s.editionId) ?? null)),
      editionId: s.editionId,
      outcome: s.outcome,
      startedOn: s.startedOn,
      startedPrecision: s.startedPrecision,
      finishedOn: s.finishedOn,
      finishedPrecision: s.finishedPrecision,
      fractionCompleted: s.fractionCompleted,
      origin: sessionOrigin.get(s.id) ?? survivorId,
      setKey: s.editionId === null ? null : (editionSet.get(s.editionId) ?? null),
    }))
    const reads = planSessionFusion(fusionSessions, volumeCount ?? highest)
    for (const read of reads) {
      for (const mergedId of read.mergeIds) {
        const mergedPoints = await tx.select({ occurredOn: readingProgress.occurredOn, editionId: readingProgress.editionId }).from(readingProgress).where(eq(readingProgress.sessionId, mergedId))
        if (mergedPoints.length > 0) {
          // one point per volume and day: the merged read's point replaces the keep read's on the same day and volume only
          const clashes = sql.join(
            mergedPoints.map((p) => sql`(${readingProgress.occurredOn} = ${p.occurredOn} and ${readingProgress.editionId} is not distinct from ${p.editionId})`),
            sql` or `,
          )
          await tx.delete(readingProgress).where(sql`${readingProgress.sessionId} = ${read.keepId} and (${clashes})`)
          await tx.update(readingProgress).set({ sessionId: read.keepId }).where(eq(readingProgress.sessionId, mergedId))
        }
        await tx.delete(readingSessions).where(eq(readingSessions.id, mergedId))
      }
      await tx
        .update(readingSessions)
        .set({
          editionId: read.editionId,
          startedOn: read.startedOn,
          startedPrecision: read.startedPrecision,
          finishedOn: read.finishedOn,
          finishedPrecision: read.finishedPrecision,
          outcome: read.outcome,
          fractionCompleted: read.fractionCompleted,
        })
        .where(eq(readingSessions.id, read.keepId))
    }

    // the status follows what is left of each person's sessions (the rule deleteReadingSession uses)
    const people = [...new Set(memberSessions.map((s) => s.userId))].sort()
    const left = await tx.select({ userId: readingSessions.userId, outcome: readingSessions.outcome }).from(readingSessions).where(eq(readingSessions.workId, survivorId))
    for (const userId of people) {
      const outcomes = left.filter((r) => r.userId === userId).map((r) => r.outcome)
      if (outcomes.length === 0) continue
      const status = outcomes.includes('in_progress') ? 'reading' : statusAfterCompletion('abandoned', outcomes)
      await tx
        .insert(userWorks)
        .values({ userId, workId: survivorId, status })
        .onConflictDoUpdate({ target: [userWorks.userId, userWorks.workId], set: { status, updatedAt: new Date() } })
    }

    const fused: string[] = []
    if (people.length > 0) {
      const rows = await tx.select({ id: users.id, name: users.displayName, role: users.role }).from(users).where(inArray(users.id, people))
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const read of reads) {
        const name = byId.get(read.userId)?.name ?? 'Someone'
        fused.push(`${name}: ${read.volumes.length} reads joined into one (vols ${read.volumes.join(', ')})`)
      }
      // every person with a session on any member: their stats may have counted a volume under its old book
      for (const id of people) {
        const user = byId.get(id)
        if (user) await rebuildDailyStats(tx, await loadUserScope(tx, { id, role: user.role }))
      }
    }
    return { workId: survivorId, dropped, fused }
  })
}
