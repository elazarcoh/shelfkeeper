import { inArray } from 'drizzle-orm'
import { volumeContexts, type EditionFormat, type EditionLength, type VolumeContext } from '@mylib/domain'
import type { Db } from '../client'
import { editions } from '../schema'

export interface EditionContext {
  workId: string
  language: string | null
  length: EditionLength
  wordCount: number | null
  format: EditionFormat
  ctx: VolumeContext | null
}

/** Each edition's own lengths and its place in its volume set (#66), for book fractions. Missing ids are absent. */
export async function loadEditionContexts(db: Db, editionIds: readonly string[]): Promise<Map<string, EditionContext>> {
  const ids = new Set(editionIds)
  const out = new Map<string, EditionContext>()
  if (ids.size === 0) return out
  const wanted = await db.select({ workId: editions.workId }).from(editions).where(inArray(editions.id, [...ids]))
  const workIds = [...new Set(wanted.map((w) => w.workId))]
  if (workIds.length === 0) return out
  const rows = await db
    .select({
      id: editions.id,
      workId: editions.workId,
      format: editions.format,
      language: editions.language,
      volume: editions.volume,
      volumeCount: editions.volumeCount,
      pageCount: editions.pageCount,
      durationSec: editions.durationSec,
      wordCount: editions.wordCount,
    })
    .from(editions)
    .where(inArray(editions.workId, workIds))
  const byWork = new Map<string, typeof rows>()
  for (const r of rows) byWork.set(r.workId, [...(byWork.get(r.workId) ?? []), r])
  const contexts = new Map<string, VolumeContext>()
  for (const list of byWork.values()) for (const [id, ctx] of volumeContexts(list)) contexts.set(id, ctx)
  for (const r of rows) {
    if (!ids.has(r.id)) continue
    out.set(r.id, { workId: r.workId, language: r.language, length: { pageCount: r.pageCount, durationSec: r.durationSec }, wordCount: r.wordCount, format: r.format, ctx: contexts.get(r.id) ?? null })
  }
  return out
}

/**
 * The edition a point counts in (#66): its own; or, when that volume is gone (edition_id null), the session's current
 * one, unless that is in a volume set, where which volume the point was in can't be known: then null (no book
 * fraction). The same when the session is in a set and the point's edition has since left it (split off, or its format,
 * language or volume edited). `undefined`: no edition to read a length from.
 */
export function editionOfPoint(editionId: string | null, sessionEditionId: string | null, contexts: ReadonlyMap<string, EditionContext>): EditionContext | null | undefined {
  const session = sessionEditionId === null ? undefined : contexts.get(sessionEditionId)
  if (editionId === null) return session?.ctx != null ? null : session
  const own = contexts.get(editionId)
  if (session?.ctx != null && editionId !== sessionEditionId && own !== undefined) {
    const sameSet = own.ctx !== null && own.workId === session.workId && own.format === session.format && own.language === session.language
    if (!sameSet) return null
  }
  return own
}
