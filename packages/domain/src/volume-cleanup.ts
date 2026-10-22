import { z } from 'zod'
import type { EditionFormat } from './enums'
import { err, ok, type Result } from './result'
import { jsonArrayIn } from './shelf'
import { normalizeText } from './text'
import { MAX_VOLUME, volumeFromTitles } from './volume-marker'

export interface VolumeCatalogEdition {
  id: string
  format: EditionFormat
  language: string | null
  isbn: string | null // isbn13 ?? isbn10
  volume: number | null
  volumeCount: number | null
}
export interface VolumeCatalogEntry {
  id: string
  title: string
  subtitle: string | null
  authors: string[] // in the work's author order
  series: { name: string; position: number | null }[]
  editions: VolumeCatalogEdition[]
}
export interface VolumeGroupMember {
  workId: string
  volume: number | null
}
export interface VolumeGroup {
  key: string // volumeGroupKey(member ids)
  source: 'app' | 'ai'
  bookTitle: string
  members: VolumeGroupMember[] // in volume order, nulls last
  volumeCount: number | null
}

export const VOLUMES_PROMPT_CHUNK = 500
export const VOLUMES_PROMPT_MAX = 2000
export const VOLUMES_MAX_ANSWER = 200_000

export const VOLUMES_PROMPT_HEAD = `Below is a list of books in a home library, as JSON, one book per line. Most are in Hebrew.

Some publishers split one book into several volumes (Hebrew: כרך א', כרך ב' or חלק 1, חלק 2), and the library may list each volume as a separate book, often with different titles. Find the books in this list that are volumes of one book.

Rules:
- Only volumes of ONE book belong together. Books of a series (book 1, book 2 of a series) are NOT volumes; leave them out.
- A volume number may be in the title, the subtitle, or only in the editions' "vol" note. If you are not sure of a volume's number, use null.
- Use the ids exactly as given. Each id may appear in at most one group.

Answer with only a JSON array, no other text, in this shape:
[{ "book_title": "the book's title without the volume marker", "works": [{ "id": "…", "volume": 1 }, { "id": "…", "volume": 2 }], "volume_count": 2 }]
Use null for volume_count when you don't know how many volumes the book has. Answer [] when there are none.

The books:
`

export function volumeGroupKey(workIds: readonly string[]): string {
  return [...workIds].sort().join(',')
}

function sortMembers(members: VolumeGroupMember[]): VolumeGroupMember[] {
  return [...members].sort((a, b) => (a.volume ?? Infinity) - (b.volume ?? Infinity))
}

/** The highest volume count any of these books (title marker or edition) states. */
function countAmong(entries: readonly VolumeCatalogEntry[]): number | null {
  let best: number | null = null
  for (const e of entries) {
    const counts = [volumeFromTitles(e.title, e.subtitle).volume?.count ?? null, ...e.editions.map((ed) => ed.volumeCount)]
    for (const c of counts) if (c !== null && (best === null || c > best)) best = c
  }
  return best
}

export function findVolumeGroups(entries: readonly VolumeCatalogEntry[]): VolumeGroup[] {
  const buckets = new Map<string, { entry: VolumeCatalogEntry; read: ReturnType<typeof volumeFromTitles> }[]>()
  for (const entry of entries) {
    const read = volumeFromTitles(entry.title, entry.subtitle)
    const key = normalizeText(read.title) + '\u0000' + normalizeText(entry.authors[0] ?? '')
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [{ entry, read }])
    else bucket.push({ entry, read })
  }
  const groups: VolumeGroup[] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    if (!bucket.some((b) => b.read.volume !== null)) continue
    if (new Set(bucket.map((b) => b.read.volume?.number ?? null)).size < 2) continue
    const members = sortMembers(bucket.map((b) => ({ workId: b.entry.id, volume: b.read.volume?.number ?? null })))
    const first = bucket.find((b) => b.entry.id === members[0]?.workId)
    groups.push({
      key: volumeGroupKey(members.map((m) => m.workId)),
      source: 'app',
      bookTitle: first?.read.title ?? '',
      members,
      volumeCount: countAmong(bucket.map((b) => b.entry)),
    })
  }
  return groups.sort((a, b) => a.bookTitle.localeCompare(b.bookTitle))
}

function compactBook(e: VolumeCatalogEntry): string {
  const editions = e.editions.map((ed) =>
    [ed.format, ed.language, ed.isbn, ed.volume === null ? null : ed.volumeCount === null ? `vol ${ed.volume}` : `vol ${ed.volume} of ${ed.volumeCount}`]
      .filter((p): p is string => p !== null)
      .join(' · '),
  )
  return JSON.stringify({
    id: e.id,
    title: e.title,
    ...(e.subtitle === null ? {} : { subtitle: e.subtitle }),
    authors: e.authors,
    ...(e.series.length === 0 ? {} : { series: e.series.map((s) => (s.position === null ? s.name : `${s.name} #${s.position}`)).join('; ') }),
    editions,
  })
}

export function volumesPrompts(entries: readonly VolumeCatalogEntry[]): { prompts: string[]; omitted: number } {
  const sorted = [...entries].sort((a, b) => normalizeText(a.title).localeCompare(normalizeText(b.title)) || a.id.localeCompare(b.id))
  const used = sorted.slice(0, VOLUMES_PROMPT_MAX)
  const prompts: string[] = []
  for (let i = 0; i < used.length; i += VOLUMES_PROMPT_CHUNK) {
    const lines = used.slice(i, i + VOLUMES_PROMPT_CHUNK).map(compactBook)
    prompts.push(VOLUMES_PROMPT_HEAD + '[\n' + lines.join(',\n') + '\n]')
  }
  return { prompts, omitted: sorted.length - used.length }
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  return Number.isInteger(n) && n >= 1 && n <= MAX_VOLUME ? n : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseVolumesAnswer(
  text: string,
  entries: readonly VolumeCatalogEntry[],
  taken: readonly VolumeGroup[],
): Result<{ groups: VolumeGroup[]; notes: string[] }, string> {
  const list = jsonArrayIn(text.slice(0, VOLUMES_MAX_ANSWER))
  if (list === null) return err('No list of groups found in the answer')
  const byId = new Map(entries.map((e) => [e.id, e]))
  const takenIds = new Set(taken.flatMap((g) => g.members.map((m) => m.workId)))
  const takenKeys = new Set(taken.map((g) => g.key))
  const used = new Set<string>()
  const groups: VolumeGroup[] = []
  const notes: string[] = []
  list.forEach((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.works)) {
      notes.push(`Item ${index + 1} is not a group, left out`)
      return
    }
    const works: { entry: VolumeCatalogEntry; volume: number | null }[] = []
    const pending: string[] = []
    for (const w of item.works as unknown[]) {
      const id = isRecord(w) && typeof w.id === 'string' ? w.id : null
      const entry = id === null ? undefined : byId.get(id)
      if (id === null || entry === undefined) {
        notes.push(`Unknown book id “${id ?? String(isRecord(w) ? w.id : w)}” left out`)
        continue
      }
      works.push({ entry, volume: numberOrNull((w as Record<string, unknown>).volume) })
    }
    const title =
      typeof item.book_title === 'string' && item.book_title.trim() !== ''
        ? item.book_title.trim()
        : works[0] === undefined
          ? ''
          : volumeFromTitles(works[0].entry.title, works[0].entry.subtitle).title
    // the app found this exact group too
    if (takenKeys.has(volumeGroupKey(works.map((w) => w.entry.id)))) return
    const kept = works.filter((w) => {
      if (used.has(w.entry.id) || takenIds.has(w.entry.id)) {
        notes.push(`“${w.entry.title}” is already in another group, left out`)
        return false
      }
      used.add(w.entry.id)
      pending.push(w.entry.id)
      return true
    })
    if (kept.length < 2) {
      for (const id of pending) used.delete(id)
      notes.push(`Group “${title}” has fewer than two books, left out`)
      return
    }
    const members = sortMembers(kept.map((w) => ({ workId: w.entry.id, volume: w.volume })))
    groups.push({
      key: volumeGroupKey(members.map((m) => m.workId)),
      source: 'ai',
      bookTitle: title,
      members,
      volumeCount: numberOrNull(item.volume_count) ?? countAmong(kept.map((w) => w.entry)),
    })
  })
  return ok({ groups, notes })
}

export interface GroupReview {
  survivorId: string
  title: string
  members: VolumeGroupMember[]
  volumeCount: number | null
}

function hasEditionVolume(entry: VolumeCatalogEntry | undefined): boolean {
  return entry?.editions.some((e) => e.volume !== null) ?? false
}

export function reviewDefaults(group: VolumeGroup, entries: readonly VolumeCatalogEntry[]): GroupReview {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const editionVolumes = (m: VolumeGroupMember) => byId.get(m.workId)?.editions.map((e) => e.volume) ?? []
  const survivor =
    group.members.find((m) => editionVolumes(m).includes(1)) ??
    group.members.find((m) => m.volume === 1) ??
    group.members.reduce<VolumeGroupMember | undefined>((best, m) => (m.volume !== null && (best === undefined || best.volume === null || m.volume < best.volume) ? m : best), undefined) ??
    group.members[0]
  const survivorEntry = survivor === undefined ? undefined : byId.get(survivor.workId)
  const title =
    group.source === 'ai' || survivorEntry === undefined ? group.bookTitle : volumeFromTitles(survivorEntry.title, survivorEntry.subtitle).title
  const members = group.members.map((m) => ({ ...m }))
  const nulls = members.filter((m) => m.volume === null)
  const only = nulls.length === 1 ? nulls[0] : undefined
  if (only !== undefined && !hasEditionVolume(byId.get(only.workId))) {
    const usedNumbers = new Set(members.map((m) => m.volume))
    let n = 1
    while (usedNumbers.has(n)) n++
    only.volume = n
  }
  return { survivorId: survivor?.workId ?? '', title, members, volumeCount: group.volumeCount }
}

export function reviewProblem(review: GroupReview, entries: readonly VolumeCatalogEntry[]): string | null {
  const byId = new Map(entries.map((e) => [e.id, e]))
  if (review.title.trim() === '') return 'The book needs a title'
  for (const m of review.members) {
    const entry = byId.get(m.workId)
    if (m.volume === null && !hasEditionVolume(entry)) return `Give “${entry?.title ?? m.workId}” a volume number`
  }
  if (review.volumeCount !== null) {
    const volumes = review.members.flatMap((m) => [m.volume, ...(byId.get(m.workId)?.editions.map((e) => e.volume) ?? [])])
    const highest = volumes.reduce<number>((max, v) => (v !== null && v > max ? v : max), 0)
    if (highest > review.volumeCount) return `The number of volumes can't be lower than volume ${highest}`
  }
  return null
}

const VolumeNumber = z.number().int().min(1).max(MAX_VOLUME)
export const MergeVolumesInput = z
  .object({
    survivorId: z.uuid(),
    title: z.string().trim().min(1).max(500),
    members: z.array(z.object({ workId: z.uuid(), volume: VolumeNumber.nullable() })).min(2).max(20),
    volumeCount: VolumeNumber.nullable(),
  })
  .refine((v) => v.members.some((m) => m.workId === v.survivorId), { message: 'The book to keep must be one of the books', path: ['survivorId'] })
  .refine((v) => new Set(v.members.map((m) => m.workId)).size === v.members.length, { message: 'The same book is listed twice', path: ['members'] })
  .refine(
    (v) => {
      const count = v.volumeCount
      return count === null || v.members.every((m) => m.volume === null || m.volume <= count)
    },
    { message: "The number of volumes can't be lower than a volume", path: ['volumeCount'] },
  )
export type MergeVolumesInput = z.output<typeof MergeVolumesInput>
