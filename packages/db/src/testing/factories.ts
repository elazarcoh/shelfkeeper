import { CreateWorkInput, normalizeText, sortTitle, type DatePrecision, type EditionFormat, type EditionOwnership, type ProgressKind, type SessionMode, type SessionOutcome, type UserRole } from '@mylib/domain'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { Db } from '../client'
import { upsertContributors, upsertSeries, upsertTags, uniqueIds, uniquePeople } from '../repos/lookups'
import { setPrimaryTitle } from '../repos/titles'
import { createUser, type UserRecord } from '../repos/users'
import { assets, contributorNames, editionContributors, editions, readingProgress, readingSessions, workContributors, workSeries, workTags, works } from '../schema'

let userCounter = 0

export async function seedUser(db: Db, opts: { username?: string; role?: UserRole } = {}): Promise<UserRecord> {
  userCounter += 1
  const username = opts.username ?? `user${userCounter}`
  return createUser(db, { username, displayName: username, passwordHash: 'not-a-real-hash', role: opts.role ?? 'member' })
}

export interface SeedWork {
  title: string
  authors?: string[]
  formats?: EditionFormat[]
  tags?: string[]
  series?: { name: string; position: number | null; positionEnd?: number | null }
  language?: string | null
  narrators?: string[]
  /** applied to every edition; defaults to owned and in possession */
  holding?: { ownership?: EditionOwnership; inPossession?: boolean }
  noEditions?: boolean
  createdAt?: Date
}

export interface SeededWork {
  workId: string
  editionIds: string[]
  authorIds: string[]
  tagIds: string[]
  seriesId: string | null
  narratorIds: string[]
}

/** Raw inserts for scope/filter tests (does not build a search document — use createWork for that). */
export async function seedWork(db: Db, w: SeedWork): Promise<SeededWork> {
  return db.transaction(async (tx) => {
    const [work] = await tx
      .insert(works)
      .values({
        title: w.title,
        sortTitle: sortTitle(w.title),
        ...(w.createdAt ? { createdAt: w.createdAt } : {}),
      })
      .returning({ id: works.id })
    if (!work) throw new Error('work insert failed')
    await setPrimaryTitle(tx, work.id, { title: w.title, subtitle: null, language: w.language ?? null })

    const authors = uniquePeople(await upsertContributors(tx, w.authors ?? ['Test Author'], w.language ?? null))
    const authorIds = authors.map((a) => a.contributorId)
    if (authors.length > 0) {
      await tx.insert(workContributors).values(authors.map((a, position) => ({ workId: work.id, contributorId: a.contributorId, nameId: a.nameId, position })))
    }
    const tagIds = uniqueIds(await upsertTags(tx, w.tags ?? []))
    if (tagIds.length > 0) await tx.insert(workTags).values(tagIds.map((tagId) => ({ workId: work.id, tagId })))

    let seriesId: string | null = null
    if (w.series) {
      const [id] = await upsertSeries(tx, [w.series.name])
      seriesId = id ?? null
      if (seriesId) await tx.insert(workSeries).values({ workId: work.id, seriesId, position: w.series.position, positionEnd: w.series.positionEnd ?? null, sortIndex: 0 })
    }

    const editionIds: string[] = []
    for (const format of w.noEditions ? [] : (w.formats ?? ['physical'])) {
      const [e] = await tx
        .insert(editions)
        .values({
          workId: work.id,
          format,
          language: w.language ?? null,
          ownership: w.holding?.ownership ?? 'owned',
          inPossession: w.holding?.inPossession ?? true,
        })
        .returning({ id: editions.id })
      if (e) editionIds.push(e.id)
    }
    const narrators = uniquePeople(await upsertContributors(tx, w.narrators ?? [], w.language ?? null))
    const narratorIds = narrators.map((n) => n.contributorId)
    const firstEdition = editionIds[0]
    if (firstEdition && narrators.length > 0) {
      await tx
        .insert(editionContributors)
        .values(narrators.map((n, position) => ({ editionId: firstEdition, contributorId: n.contributorId, nameId: n.nameId, role: 'narrator' as const, position })))
    }
    return { workId: work.id, editionIds, authorIds, tagIds, seriesId, narratorIds }
  })
}

/** Gives a person another name, as Stage 2's merge will (tests only). */
export async function seedName(db: Db, contributorId: string, name: string, language: string | null = null): Promise<string> {
  const [row] = await db.insert(contributorNames).values({ contributorId, name, normalizedName: normalizeText(name), language }).returning({ id: contributorNames.id })
  if (!row) throw new Error('seedName failed')
  return row.id
}

export function workInput(overrides: Partial<z.input<typeof CreateWorkInput>> = {}): CreateWorkInput {
  return CreateWorkInput.parse({
    title: 'The Final Empire',
    authors: ['Brandon Sanderson'],
    series: [{ name: 'Mistborn', position: 1 }],
    editions: [{ format: 'physical' }],
    ...overrides,
  })
}

export interface SeedSession {
  userId: string
  workId: string
  editionId?: string | null
  mode?: SessionMode
  startedOn: string
  startedPrecision?: DatePrecision
  outcome?: SessionOutcome
  finishedOn?: string | null
  finishedPrecision?: DatePrecision | null
  fractionCompleted?: number | null
  isReread?: boolean
}

/** Raw insert for repository tests that don't yet have (or don't want to exercise) the sessions repo itself. */
export async function seedSession(db: Db, s: SeedSession): Promise<string> {
  const [row] = await db
    .insert(readingSessions)
    .values({
      userId: s.userId,
      workId: s.workId,
      editionId: s.editionId ?? null,
      mode: s.mode ?? 'read',
      startedOn: s.startedOn,
      startedPrecision: s.startedPrecision ?? 'day',
      outcome: s.outcome ?? 'in_progress',
      finishedOn: s.finishedOn ?? null,
      finishedPrecision: s.finishedPrecision ?? (s.finishedOn ? 'day' : null),
      fractionCompleted: s.fractionCompleted ?? null,
      isReread: s.isReread ?? false,
    })
    .returning({ id: readingSessions.id })
  if (!row) throw new Error('session insert failed')
  return row.id
}

/** An asset set as an edition's cover. */
export async function seedCover(db: Db, editionId: string, stored: { path: string; sha256: string; mime: string }): Promise<string> {
  const [asset] = await db.insert(assets).values({ kind: 'cover', ...stored }).returning({ id: assets.id })
  if (!asset) throw new Error('asset insert failed')
  await db.update(editions).set({ coverAssetId: asset.id }).where(eq(editions.id, editionId))
  return asset.id
}

/** Raw insert of a progress point, for stats and backup tests that don't exercise the progress repository. */
export async function seedProgress(db: Db, p: { sessionId: string; on: string; kind: ProgressKind; value: number }): Promise<string> {
  const [row] = await db
    .insert(readingProgress)
    .values({ sessionId: p.sessionId, occurredOn: p.on, kind: p.kind, value: p.value })
    .returning({ id: readingProgress.id })
  if (!row) throw new Error('progress insert failed')
  return row.id
}
