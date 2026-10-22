import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  autoKindApplies,
  changedEditionFields,
  editionFieldNames,
  editionInputFromItem,
  inferKind,
  initialHoldingEvent,
  isLocked,
  markManual,
  markSource,
  normalizeText,
  sortTitle,
  setForVolume,
  volumeSets,
  type CsvOwnership,
  type EditionInput,
  type EditionOwnership,
  type ExternalItem,
  type HoldingEventType,
  type HoldingOrigin,
  type Provenance,
  type WorkKind,
} from '@mylib/domain'
import type { Db } from '../client'
import { contributorNames, editionContributors, editionHoldingEvents, editions, series, seriesNames, tags, workSeries, workTags, workTitles, works } from '../schema'
import { clearSetVolumeCount, lockWorkEditions, replaceAuthors, replaceEditionPeople, replaceSeries, replaceTags, syncVolumeCount } from './catalog'
import { shownName } from './person-names'
import { refreshSearchDocument } from './search-index'
import { setPrimaryTitle } from './titles'

export const UNKNOWN_AUTHOR = 'Unknown author'

/** Sync-originated holding events are dated by the server's UTC day — there is no person whose "today" applies. */
const utcDay = (at: Date): string => at.toISOString().slice(0, 10)

type EditionValues = {
  isbn13: string | null
  isbn10: string | null
  asin: string | null
  publisher: string | null
  publishedOn: string | null
  pageCount: number | null
  wordCount: number | null
  durationSec: number | null
  language: string | null
}

function editionValues(item: ExternalItem): EditionValues {
  return {
    isbn13: item.identifiers.isbn13,
    isbn10: item.identifiers.isbn10,
    asin: item.identifiers.asin,
    publisher: item.publisher,
    publishedOn: item.publishedOn,
    pageCount: item.pageCount,
    wordCount: item.wordCount,
    durationSec: item.durationSec,
    language: item.language,
  }
}

const present = (v: unknown): boolean => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)

/** How a copy created from an item is held, and the first entry of its holding history. */
export interface NewEditionHolding {
  ownership: EditionOwnership
  inPossession: boolean
  event: { type: HoldingEventType; note: string; origin: HoldingOrigin; occurredOn: string | null }
}

/** A copy found by a sync: owned and here, dated by the server's UTC day (no person's "today" applies). */
export const FOUND_IN_SOURCE: NewEditionHolding = { ownership: 'owned', inPossession: true, event: { type: 'acquired', note: 'Found in a source', origin: 'sync', occurredOn: null } }

/** How an imported copy is held (CSV file or shelf photo), dated by the importer's own `today`. */
export function importHolding(ownership: CsvOwnership, today: string, how: { note: string; borrowedFrom?: string | null }): NewEditionHolding {
  if (ownership === 'owned') return { ownership: 'owned', inPossession: true, event: { type: 'acquired', note: how.note, origin: 'manual', occurredOn: today } }
  if (ownership === 'borrowed') {
    return { ownership: 'borrowed', inPossession: true, event: { type: 'borrowed', note: how.borrowedFrom?.trim() || 'Borrowed', origin: 'manual', occurredOn: today } }
  }
  return { ownership: 'borrowed', inPossession: false, event: { type: 'returned', note: `${how.note} (read, not owned)`, origin: 'manual', occurredOn: today } }
}

/** The notes an imported copy's first holding event carries (and a blank form note falls back to). */
export const CSV_IMPORT_NOTE = 'Imported from a CSV file'
export const SHELF_PHOTO_NOTE = 'Added from a shelf photo'

/** A copy a person imported from a CSV file, dated by their local `today` (plan deviation 11). */
export function csvHolding(ownership: CsvOwnership, today: string): NewEditionHolding {
  return importHolding(ownership, today, { note: CSV_IMPORT_NOTE })
}

async function insertEditionFromItem(
  db: Db,
  sourceId: string,
  workId: string,
  item: ExternalItem,
  actorUserId: string | null,
  at: Date,
  holding: NewEditionHolding,
): Promise<string> {
  const values = editionValues(item)
  const provided = [...Object.keys(values).filter((k) => present(values[k as keyof EditionValues])), ...(item.narrators.length > 0 ? ['narrators'] : []), ...(item.translators.length > 0 ? ['translators'] : [])]
  const [row] = await db
    .insert(editions)
    .values({ workId, format: item.format, ...values, volume: item.volume?.number ?? null, volumeCount: item.volume?.count ?? null, ownership: holding.ownership, inPossession: holding.inPossession, provenance: markSource({}, provided, sourceId, at) })
    .returning({ id: editions.id })
  if (!row) throw new Error('edition insert failed')
  await db.insert(editionHoldingEvents).values({
    editionId: row.id,
    type: holding.event.type,
    occurredOn: holding.event.occurredOn ?? utcDay(at),
    note: holding.event.note,
    origin: holding.event.origin,
    actorUserId,
  })
  await replaceEditionPeople(db, row.id, 'narrator', item.narrators, item.language)
  await replaceEditionPeople(db, row.id, 'translator', item.translators, item.language)
  return row.id
}

async function insertWorkFromItem(db: Db, sourceId: string, item: ExternalItem, at: Date): Promise<string> {
  const workFields = { title: item.title, subtitle: item.subtitle, description: item.description }
  const provided = [
    ...Object.keys(workFields).filter((k) => present(workFields[k as keyof typeof workFields])),
    ...(item.authors.length > 0 ? ['authors'] : []),
    ...(item.series.length > 0 ? ['series'] : []),
    ...(item.tags.length > 0 ? ['tags'] : []),
  ]
  // a tag or a site link in the description says fanfiction or web serial; the kind stays unlocked like any source value
  const kind = inferKind({ tags: item.tags, texts: [item.description] })
  if (kind !== null) provided.push('kind')
  const [work] = await db
    .insert(works)
    .values({ ...workFields, ...(kind !== null ? { kind } : {}), sortTitle: sortTitle(item.title), provenance: markSource({}, provided, sourceId, at) })
    .returning({ id: works.id })
  if (!work) throw new Error('work insert failed')
  await setPrimaryTitle(db, work.id, { title: item.title, subtitle: item.subtitle, language: item.language })
  await replaceAuthors(db, work.id, item.authors.length > 0 ? item.authors : [UNKNOWN_AUTHOR], item.language)
  await replaceSeries(db, work.id, item.series)
  await replaceTags(db, work.id, item.tags)
  return work.id
}

export async function createWorkFromItem(
  db: Db,
  sourceId: string,
  item: ExternalItem,
  actorUserId: string | null,
  holding: NewEditionHolding = FOUND_IN_SOURCE,
): Promise<{ workId: string; editionId: string }> {
  const at = new Date()
  const workId = await insertWorkFromItem(db, sourceId, item, at)
  const editionId = await insertEditionFromItem(db, sourceId, workId, item, actorUserId, at, holding)
  await refreshSearchDocument(db, workId)
  return { workId, editionId }
}

/** A wanted book: the work alone, no edition (spec §4 "wanted"). */
export async function createWantedWork(db: Db, sourceId: string, item: ExternalItem): Promise<string> {
  const workId = await insertWorkFromItem(db, sourceId, item, new Date())
  await refreshSearchDocument(db, workId)
  return workId
}

/** The kind an item's tags and description give a work, or null when a rule must not touch it (see autoKindApplies). */
function autoKindFromItem(work: { kind: WorkKind; provenance: Provenance }, item: ExternalItem): WorkKind | null {
  return autoKindApplies(work) ? inferKind({ tags: item.tags, texts: [item.description] }) : null
}

/** A new copy of an existing work brings its item's signals too: promote an unset book, unlocked and from the source. */
async function promoteKindFromItem(db: Db, workId: string, sourceId: string, item: ExternalItem, at: Date): Promise<void> {
  const [work] = await db.select({ kind: works.kind, provenance: works.provenance }).from(works).where(eq(works.id, workId)).for('update')
  const kind = work ? autoKindFromItem(work, item) : null
  if (!work || kind === null) return
  await db.update(works).set({ kind, provenance: markSource(work.provenance, ['kind'], sourceId, at) }).where(eq(works.id, workId))
}

/**
 * A copy of an existing book from a source item. A volume joins its set (#66): an unknown language takes the
 * language of the book's only set in that format, a count the set has outgrown is dropped, and the set's
 * count is then kept consistent — never refused, since an import must not fail on a count.
 */
export async function addEditionFromItem(
  db: Db,
  sourceId: string,
  workId: string,
  item: ExternalItem,
  actorUserId: string | null,
  holding: NewEditionHolding = FOUND_IN_SOURCE,
): Promise<string> {
  let it = item
  let clearsCount = false
  if (item.volume !== null) {
    // editions by id before anything else, as addEdition/updateEdition do
    await lockWorkEditions(db, workId)
    const rows = await db
      .select({ id: editions.id, format: editions.format, language: editions.language, volume: editions.volume, volumeCount: editions.volumeCount })
      .from(editions)
      .where(eq(editions.workId, workId))
    // the same set matching showed; the new volume takes that set's language
    const set = setForVolume(volumeSets(rows), item.format, item.language)
    const language = set === undefined ? item.language : set.language
    const top = Math.max(0, ...(set?.members.map((m) => m.volume ?? 0) ?? []))
    // the set's established count wins on import; the item's count only counts for a set that has none
    const setHasCount = set?.members.some((m) => m.volumeCount !== null) ?? false
    const count = !setHasCount && item.volume.count !== null && item.volume.count >= top ? item.volume.count : null
    it = { ...item, language, volume: { number: item.volume.number, count } }
    // a volume above the set's established count: the count was wrong, so the whole set forgets it
    clearsCount = item.volume.number > Math.max(0, ...(set?.members.map((m) => m.volumeCount ?? 0) ?? [])) && setHasCount
  }
  const at = new Date()
  const id = await insertEditionFromItem(db, sourceId, workId, it, actorUserId, at, holding)
  await promoteKindFromItem(db, workId, sourceId, item, at)
  if (it.volume !== null) {
    if (clearsCount) await clearSetVolumeCount(db, workId, it.format, it.language)
    await syncVolumeCount(db, workId, id)
  }
  await refreshSearchDocument(db, workId)
  return id
}

/** A copy the person described in the Add edition form (#121): blank date = their today; a blank note says how it came. */
export function formHolding(input: EditionInput, today: string, importNote: string): NewEditionHolding {
  return {
    ownership: input.ownership,
    inPossession: true,
    event: { type: initialHoldingEvent(input.ownership), note: input.holdingNote ?? (input.ownership === 'borrowed' ? 'Borrowed' : importNote), origin: 'manual', occurredOn: input.holdingOn ?? today },
  }
}

/** The form's holding keys: no edition columns, `holding` decides them. */
const HOLDING_KEYS = ['ownership', 'holdingOn', 'holdingNote'] as const

/**
 * A copy of an existing book from a source item, as the person filled in the Add edition form (#121). What they
 * changed from the item is locked like a manual edit; the rest stays the source's, so later syncs may update it.
 * The volume follows manual Add edition's rules, not the lenient import ones: a count below a volume of the set is refused.
 */
export async function addEditionFromForm(
  db: Db,
  sourceId: string,
  workId: string,
  item: ExternalItem,
  input: EditionInput,
  actorUserId: string | null,
  holding: NewEditionHolding,
): Promise<string> {
  // editions by id before anything else, as addEdition/updateEdition do
  await lockWorkEditions(db, workId)
  const at = new Date()
  const base = editionInputFromItem(item)
  const changed = changedEditionFields(base, input)
  const fromItem = editionFieldNames.filter((f) => present(base[f]) && !changed.includes(f))
  // an untouched duration stays the item's exact seconds: the form only shows whole minutes
  const durationSec = changed.includes('durationSec') ? input.durationSec : base.durationSec
  const { narrators, translators, ...rest } = input
  const fields = Object.fromEntries(Object.entries(rest).filter(([k]) => !HOLDING_KEYS.some((h) => h === k))) as Omit<typeof rest, (typeof HOLDING_KEYS)[number]>
  const [row] = await db
    .insert(editions)
    .values({ workId, ...fields, durationSec, ownership: holding.ownership, inPossession: holding.inPossession, provenance: markManual(markSource({}, fromItem, sourceId, at), changed, at) })
    .returning({ id: editions.id })
  if (!row) throw new Error('edition insert failed')
  await db.insert(editionHoldingEvents).values({
    editionId: row.id,
    type: holding.event.type,
    occurredOn: holding.event.occurredOn ?? utcDay(at),
    note: holding.event.note,
    origin: holding.event.origin,
    actorUserId,
  })
  // new people are named in the edition's language
  await replaceEditionPeople(db, row.id, 'narrator', narrators, input.language)
  await replaceEditionPeople(db, row.id, 'translator', translators, input.language)
  await syncVolumeCount(db, workId, row.id)
  await promoteKindFromItem(db, workId, sourceId, item, at)
  await refreshSearchDocument(db, workId)
  return row.id
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.map(normalizeText).join('\u0000') === b.map(normalizeText).join('\u0000')

/** Every normalized name of each series (primary included), by series id. */
async function seriesNameSets(db: Db, seriesIds: string[]): Promise<Map<string, Set<string>>> {
  const sets = new Map<string, Set<string>>(seriesIds.map((id) => [id, new Set<string>()]))
  if (seriesIds.length === 0) return sets
  const rows = await db.select({ id: seriesNames.seriesId, n: seriesNames.normalizedName }).from(seriesNames).where(inArray(seriesNames.seriesId, seriesIds))
  for (const r of rows) sets.get(r.id)?.add(r.n)
  return sets
}

/** Every normalized name of each person (the primary included), by contributor id. */
async function personNameSets(db: Db, personIds: string[]): Promise<Map<string, Set<string>>> {
  const sets = new Map<string, Set<string>>(personIds.map((id) => [id, new Set<string>()]))
  if (personIds.length === 0) return sets
  const rows = await db.select({ id: contributorNames.contributorId, n: contributorNames.normalizedName }).from(contributorNames).where(inArray(contributorNames.contributorId, personIds))
  for (const r of rows) sets.get(r.id)?.add(r.n)
  return sets
}

/**
 * #115: a push to Audiobookshelf adds "<title>" at the volume number as an extra series entry. Read back it must not
 * become a real series: drop an entry at this edition's volume that is named like the book (any title, or the shown edition title).
 */
function withoutVolumeEntry(incoming: ExternalItem['series'], volume: number | null, bookTitles: readonly string[]): ExternalItem['series'] {
  if (volume === null) return incoming
  const titles = new Set(bookTitles.map(normalizeText))
  return incoming.filter((s) => !(s.position === volume && s.positionEnd === null && titles.has(normalizeText(s.name))))
}

/** Spec §4.2: changes to a linked item are applied unless the field is locked. Title and authors are never auto-changed. */
export async function applyItemToEdition(db: Db, sourceId: string, editionId: string, item: ExternalItem): Promise<string[]> {
  const at = new Date()
  const [edition] = await db.select().from(editions).where(eq(editions.id, editionId)).for('update')
  if (!edition) return []
  const changed: string[] = []

  // --- edition fields
  const next = editionValues(item)
  const editionPatch: Partial<EditionValues> = {}
  let editionProvenance: Provenance = edition.provenance
  for (const field of Object.keys(next) as (keyof EditionValues)[]) {
    const value = next[field]
    if (!present(value) || isLocked(edition.provenance, field) || edition[field] === value) continue
    Object.assign(editionPatch, { [field]: value })
    editionProvenance = markSource(editionProvenance, [field], sourceId, at)
    changed.push(field)
  }
  if (item.narrators.length > 0 && !isLocked(edition.provenance, 'narrators')) {
    const current = await db
      .select({ id: editionContributors.contributorId, name: shownName(editionContributors.nameId, editionContributors.contributorId) })
      .from(editionContributors)
      .where(and(eq(editionContributors.editionId, editionId), eq(editionContributors.role, 'narrator')))
      .orderBy(asc(editionContributors.position))
    // R11: the same person under any of their names is no change (an English audiobook of a Hebrew-primary book)
    const names = await personNameSets(db, current.map((c) => c.id))
    const same =
      current.length === item.narrators.length &&
      current.every((c, i) => {
        const incoming = normalizeText(item.narrators[i] ?? '')
        return incoming === normalizeText(c.name) || names.get(c.id)?.has(incoming) === true
      })
    if (!same) {
      await replaceEditionPeople(db, editionId, 'narrator', item.narrators, item.language)
      editionProvenance = markSource(editionProvenance, ['narrators'], sourceId, at)
      changed.push('narrators')
    }
  }
  if (changed.length > 0) await db.update(editions).set({ ...editionPatch, provenance: editionProvenance }).where(eq(editions.id, editionId))

  // --- work fields (never title/authors — see the plan's deviations)
  const [work] = await db.select().from(works).where(eq(works.id, edition.workId)).for('update')
  if (work) {
    let workProvenance: Provenance = work.provenance
    const workPatch: { subtitle?: string; description?: string; kind?: WorkKind } = {}
    let subtitle = work.subtitle
    const titleRows = await db.select({ title: workTitles.title, subtitle: workTitles.subtitle }).from(workTitles).where(eq(workTitles.workId, work.id))
    const knownSubtitles = new Set([edition.subtitle, ...titleRows.map((r) => r.subtitle)].filter((s): s is string => s !== null).map((s) => s.trim()))
    for (const field of ['subtitle', 'description'] as const) {
      const value = item[field]
      if (value === null || isLocked(work.provenance, field) || work[field] === value) continue
      // R11: a subtitle the book already has in any language (or on this edition) is no change
      if (field === 'subtitle' && knownSubtitles.has(value.trim())) continue
      if (field === 'subtitle') subtitle = value
      else workPatch[field] = value
      workProvenance = markSource(workProvenance, [field], sourceId, at)
      changed.push(`work.${field}`)
    }
    const incomingSeries = withoutVolumeEntry(item.series, edition.volume, [...titleRows.map((r) => r.title), ...(edition.title ? [edition.title] : [])])
    if (incomingSeries.length > 0 && !isLocked(work.provenance, 'series')) {
      const current = await db
        .select({ id: series.id, name: series.name, position: workSeries.position, positionEnd: workSeries.positionEnd })
        .from(workSeries)
        .innerJoin(series, eq(series.id, workSeries.seriesId))
        .where(eq(workSeries.workId, work.id))
        .orderBy(asc(workSeries.sortIndex))
      // R11: a series is the same under any of its names
      const names = await seriesNameSets(db, current.map((s) => s.id))
      const same =
        current.length === incomingSeries.length &&
        current.every((s, i) => {
          const inc = incomingSeries[i]
          if (!inc || s.position !== inc.position || s.positionEnd !== inc.positionEnd) return false
          const n = normalizeText(inc.name)
          return n === normalizeText(s.name) || names.get(s.id)?.has(n) === true
        })
      if (!same) {
        await replaceSeries(db, work.id, incomingSeries)
        workProvenance = markSource(workProvenance, ['series'], sourceId, at)
        changed.push('work.series')
      }
    }
    if (item.tags.length > 0 && !isLocked(work.provenance, 'tags')) {
      const current = await db
        .select({ name: tags.name })
        .from(workTags)
        .innerJoin(tags, eq(tags.id, workTags.tagId))
        .where(eq(workTags.workId, work.id))
      if (!sameNames(current.map((c) => c.name).sort(), [...item.tags].sort())) {
        await replaceTags(db, work.id, item.tags)
        workProvenance = markSource(workProvenance, ['tags'], sourceId, at)
        changed.push('work.tags')
      }
    }
    // the sync may only promote a book nobody has set; a kind once set (by hand or by a rule) is never touched
    const kind = autoKindFromItem(work, item)
    if (kind !== null) {
      workPatch.kind = kind
      workProvenance = markSource(workProvenance, ['kind'], sourceId, at)
      changed.push('work.kind')
    }
    if (changed.some((c) => c.startsWith('work.'))) {
      if (subtitle !== work.subtitle) await setPrimaryTitle(db, work.id, { title: work.title, subtitle })
      await db.update(works).set({ ...workPatch, provenance: workProvenance }).where(eq(works.id, work.id))
    }
    if (changed.length > 0) await refreshSearchDocument(db, work.id)
  }
  return changed
}

export async function removeEditionForSource(db: Db, editionId: string, at: Date): Promise<boolean> {
  const [e] = await db.select({ ownership: editions.ownership, inPossession: editions.inPossession }).from(editions).where(eq(editions.id, editionId)).for('update')
  if (!e || e.ownership !== 'owned' || !e.inPossession) return false
  await db.update(editions).set({ inPossession: false }).where(eq(editions.id, editionId))
  await db.insert(editionHoldingEvents).values({ editionId, type: 'removed', occurredOn: utcDay(at), note: 'No longer in the source', origin: 'sync' })
  return true
}

export async function restoreEditionForSource(
  db: Db,
  editionId: string,
  at: Date,
  actorUserId: string | null,
  options: { onlyUndoSync: boolean },
): Promise<boolean> {
  const [e] = await db.select({ ownership: editions.ownership, inPossession: editions.inPossession }).from(editions).where(eq(editions.id, editionId)).for('update')
  if (!e || e.ownership !== 'owned' || e.inPossession) return false
  if (options.onlyUndoSync) {
    // the automatic sync path only undoes a removal the sync itself made: a person's "No longer
    // have it" is never overridden without a human looking at this specific copy
    const [latest] = await db
      .select({ type: editionHoldingEvents.type, origin: editionHoldingEvents.origin })
      .from(editionHoldingEvents)
      .where(eq(editionHoldingEvents.editionId, editionId))
      .orderBy(desc(editionHoldingEvents.createdAt), desc(editionHoldingEvents.occurredOn))
      .limit(1)
    if (latest?.type !== 'removed' || latest.origin !== 'sync') return false
  }
  await db.update(editions).set({ inPossession: true }).where(eq(editions.id, editionId))
  await db.insert(editionHoldingEvents).values({
    editionId,
    type: 'restored',
    occurredOn: utcDay(at),
    note: options.onlyUndoSync ? 'Back in the source' : 'Restored from the Inbox',
    origin: options.onlyUndoSync ? 'sync' : 'manual',
    actorUserId,
  })
  return true
}
