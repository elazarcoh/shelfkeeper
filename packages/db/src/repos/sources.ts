import { asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  DomainError,
  isSyncedKind,
  notFound,
  publicSourceConfig,
  SourceConfig,
  SourceConfigUpdate,
  SourceKind,
  sourceSecretFields,
  syncedSourceKinds,
  type CreateSourceInput,
  type PublicSourceConfig,
  type SourceSchedule,
  type SyncedSourceKind,
  type UpdateSourceInput,
} from '@mylib/domain'
import type { Db } from '../client'
import { jobRuns, sources, type JobStatus } from '../schema'
import { SecretUnreadableError, type SecretBox } from '../secrets'
import { requireAdmin, type UserScope } from './scope'

export interface SourceView {
  id: string
  kind: SyncedSourceKind
  name: string
  config: PublicSourceConfig
  schedule: SourceSchedule | null
  lastSyncAt: Date | null
  lastSyncStatus: JobStatus | null
  createdAt: Date
  /** a stored secret can't be decrypted with the current APP_SECRET_KEY — the admin must re-enter it */
  credentialsUnreadable: boolean
}

export const UNREADABLE_SOURCE_SECRET = "The stored API token can't be read (APP_SECRET_KEY changed?) — re-enter it."

const StoredKind = z.object({ kind: SourceKind })

function secretFieldsOf(kind: SourceKind): readonly string[] {
  if (!isSyncedKind(kind)) throw new Error(`"${kind}" sources have no connector config`)
  return sourceSecretFields[kind]
}

function seal(box: SecretBox, config: SourceConfig): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...config }
  for (const field of secretFieldsOf(config.kind)) {
    const value = stored[field]
    if (typeof value === 'string') stored[field] = box.seal(value)
  }
  return stored
}

function open(box: SecretBox, stored: Record<string, unknown>): SourceConfig {
  const { kind } = StoredKind.parse(stored)
  const plain: Record<string, unknown> = { ...stored }
  for (const field of secretFieldsOf(kind)) {
    const value = plain[field]
    if (typeof value === 'string') plain[field] = box.open(value)
  }
  return SourceConfig.parse(plain)
}

/** Like `open`, but a secret that can't be decrypted becomes a readable DomainError. */
function openOrExplain(box: SecretBox, stored: Record<string, unknown>): SourceConfig {
  try {
    return open(box, stored)
  } catch (error) {
    if (error instanceof SecretUnreadableError) throw new DomainError('INVALID', UNREADABLE_SOURCE_SECRET)
    throw error
  }
}

function canOpen(box: SecretBox, stored: Record<string, unknown>): boolean {
  try {
    open(box, stored)
    return true
  } catch (error) {
    if (error instanceof SecretUnreadableError) return false
    throw error
  }
}

/** The public view is built from the stored value without decrypting anything. */
function publicConfigOf(stored: Record<string, unknown>): PublicSourceConfig {
  const { kind } = StoredKind.parse(stored)
  const secrets = secretFieldsOf(kind)
  const config = SourceConfigUpdate.parse(Object.fromEntries(Object.entries(stored).filter(([field]) => !secrets.includes(field))))
  return publicSourceConfig(config, secrets.some((field) => typeof stored[field] === 'string' && stored[field] !== ''))
}

/** Stands in for a kept secret while the rest of the config is validated; never stored. */
const KEPT_SECRET = 'kept-secret'

export async function createSource(db: Db, scope: UserScope, box: SecretBox, input: CreateSourceInput): Promise<string> {
  requireAdmin(scope)
  const [row] = await db
    .insert(sources)
    .values({ kind: input.config.kind, name: input.name, config: seal(box, input.config), schedule: input.schedule })
    .returning({ id: sources.id })
  if (!row) throw new Error('source insert failed')
  return row.id
}

export async function updateSource(db: Db, scope: UserScope, box: SecretBox, sourceId: string, patch: UpdateSourceInput): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ kind: sources.kind, config: sources.config }).from(sources).where(eq(sources.id, sourceId)).for('update')
    if (!row) throw notFound('Source')
    let config: Record<string, unknown> | undefined
    if (patch.config !== undefined) {
      if (patch.config.kind !== row.kind) throw new DomainError('INVALID', 'A source cannot change its kind')
      const given: Record<string, unknown> = { ...patch.config }
      const kept = secretFieldsOf(row.kind).filter((field) => given[field] === undefined)
      // A blank secret keeps the stored (sealed) value without decrypting it, so a changed key can be recovered
      // from by re-entering the secret — but keeping one that can no longer be read is refused with an explanation.
      if (kept.some((field) => typeof row.config[field] === 'string') && !canOpen(box, row.config)) {
        throw new DomainError('INVALID', UNREADABLE_SOURCE_SECRET)
      }
      const placeholders = Object.fromEntries(kept.map((field) => [field, typeof row.config[field] === 'string' ? KEPT_SECRET : null]))
      const sealed = seal(box, SourceConfig.parse({ ...given, ...placeholders }))
      for (const field of kept) sealed[field] = row.config[field] ?? null
      config = sealed
    }
    await tx.update(sources).set({ name: patch.name, schedule: patch.schedule, config }).where(eq(sources.id, sourceId))
  })
}

/** What removing a source discards (its pending Inbox proposals) and keeps (the books it brought in). */
export async function sourceRemovalInfo(db: Db, scope: UserScope, sourceId: string): Promise<{ pendingProposals: number; books: number }> {
  requireAdmin(scope)
  const [row] = await db.execute<{ found: boolean; pending: number; books: number }>(sql`select
      exists (select 1 from source where id = ${sourceId}) as found,
      (select count(*)::int from proposal p join source_item i on i.id = p.source_item_id where i.source_id = ${sourceId} and p.status = 'pending') as pending,
      (select count(distinct i.work_id)::int from source_item i where i.source_id = ${sourceId} and i.work_id is not null) as books`)
  if (!row?.found) throw notFound('Source')
  return { pendingProposals: row.pending, books: row.books }
}

/**
 * Removes a source with its items (external ids), proposals and job history, by the foreign keys' cascade.
 * Books and editions stay: they're the household's catalog now. Refused while a sync is running.
 */
export async function deleteSource(db: Db, scope: UserScope, sourceId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, sourceId)).for('update')
    if (!row) throw notFound('Source')
    const [running] = await tx.select({ id: jobRuns.id }).from(jobRuns).where(sql`${jobRuns.sourceId} = ${sourceId} and ${jobRuns.status} = 'running'`).limit(1)
    if (running) throw new DomainError('CONFLICT', 'A sync of this source is running — try again when it finishes')
    await tx.delete(sources).where(eq(sources.id, sourceId))
  })
}

export async function listSources(db: Db, scope: UserScope, box: SecretBox): Promise<SourceView[]> {
  requireAdmin(scope)
  const rows = await db
    .select()
    .from(sources)
    .where(inArray(sources.kind, [...syncedSourceKinds]))
    .orderBy(asc(sources.createdAt))
  return rows.map((r) => {
    const config = publicConfigOf(r.config)
    return {
      id: r.id,
      kind: config.kind,
      name: r.name,
      config,
      schedule: r.schedule,
      lastSyncAt: r.lastSyncAt,
      lastSyncStatus: r.lastSyncStatus,
      createdAt: r.createdAt,
      credentialsUnreadable: !canOpen(box, r.config),
    }
  })
}

export async function getSourceConfig(db: Db, scope: UserScope, box: SecretBox, sourceId: string): Promise<SourceConfig> {
  requireAdmin(scope)
  const [row] = await db.select({ kind: sources.kind, config: sources.config }).from(sources).where(eq(sources.id, sourceId))
  if (!row || !isSyncedKind(row.kind)) throw notFound('Source')
  return openOrExplain(box, row.config)
}

/** For the worker: no user scope — syncing is a household-level operation. */
export async function loadSourceForSync(
  db: Db,
  box: SecretBox,
  sourceId: string,
): Promise<{ id: string; name: string; config: SourceConfig } | null> {
  const [row] = await db
    .select({ id: sources.id, kind: sources.kind, name: sources.name, config: sources.config })
    .from(sources)
    .where(eq(sources.id, sourceId))
  if (!row || !isSyncedKind(row.kind)) return null
  return { id: row.id, name: row.name, config: openOrExplain(box, row.config) }
}

export async function listScheduledSources(db: Db): Promise<{ id: string; schedule: SourceSchedule }[]> {
  const rows = await db.select({ id: sources.id, schedule: sources.schedule }).from(sources).where(isNotNull(sources.schedule))
  return rows.flatMap((r) => (r.schedule === null ? [] : [{ id: r.id, schedule: r.schedule }]))
}

/**
 * Restore step 6 (spec §4). Every stored secret sealed with `from` (the backup's key) is sealed again
 * with `to` (this install's key).
 * - A secret `to` already opens is left alone: same key, or already re-sealed.
 * - A secret neither key opens was already unreadable in the backup. It is kept as it is and counted,
 *   and Admin → Sources asks for it again (Review Focus 5). `unreadableSources` names each source with
 *   at least one such secret, for the restore summary.
 * The caller runs this in one transaction, so a failure part-way re-seals nothing.
 */
export async function resealSourceSecrets(db: Db, from: SecretBox, to: SecretBox): Promise<{ resealed: number; unreadable: number; unreadableSources: string[] }> {
  const opens = (box: SecretBox, value: string): string | null => {
    try {
      return box.open(value)
    } catch (error) {
      if (error instanceof SecretUnreadableError) return null
      throw error
    }
  }
  let resealed = 0
  let unreadable = 0
  const unreadableSources: string[] = []
  const rows = await db.select({ id: sources.id, kind: sources.kind, name: sources.name, config: sources.config }).from(sources).orderBy(sources.name)
  for (const row of rows) {
    if (!isSyncedKind(row.kind)) continue
    const next: Record<string, unknown> = { ...row.config }
    let changed = false
    let lost = false
    for (const field of sourceSecretFields[row.kind]) {
      const value = next[field]
      if (typeof value !== 'string' || value === '') continue
      if (opens(to, value) !== null) continue
      const plain = opens(from, value)
      if (plain === null) {
        unreadable++
        lost = true
        continue
      }
      next[field] = to.seal(plain)
      changed = true
      resealed++
    }
    if (lost) unreadableSources.push(row.name)
    if (changed) await db.update(sources).set({ config: next }).where(eq(sources.id, row.id))
  }
  return { resealed, unreadable, unreadableSources }
}
