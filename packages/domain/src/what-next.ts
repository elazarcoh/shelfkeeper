import { z } from 'zod'
import { workKinds } from './enums'
import { err, ok, type Result } from './result'
import { SHELF_MAX_ANSWER, jsonArrayIn } from './shelf'
import { sameTitleAndAuthor, type HardcoverBookSeries } from './hardcover'
import { normalizeText } from './text'

export const whatNextMoods = ['keep_going', 'light', 'surprise'] as const
export type WhatNextMood = (typeof whatNextMoods)[number]
export const whatNextFormats = ['audio', 'any'] as const
export type WhatNextFormat = (typeof whatNextFormats)[number]

export const WHAT_NEXT = {
  maxPerList: 5,
  lastFinishedDays: 60,
  heavyPages: 600,
  heavyAudioSec: 72_000,
  lightPages: 400,
  lightAudioSec: 43_200,
  heavyMoods: ['dark', 'tense', 'emotional', 'challenging', 'sad'],
  lightMoods: ['funny', 'lighthearted', 'hopeful', 'relaxing'],
  newPastMonths: 24,
  newFutureMonths: 6,
  promptReadCap: 400,
  promptTopRated: 30,
} as const

export interface BookLength {
  pages: number | null
  audioSec: number | null
}

/** Pages ≥ 600, audio ≥ 20 h, or a heavy Hardcover mood. No known length is not heavy by length. */
export function isHeavy(len: BookLength, moods: string[]): boolean {
  if (len.pages !== null && len.pages >= WHAT_NEXT.heavyPages) return true
  if (len.audioSec !== null && len.audioSec >= WHAT_NEXT.heavyAudioSec) return true
  return moods.some((m) => (WHAT_NEXT.heavyMoods as readonly string[]).includes(m))
}

/** Known to be short (pages under 400 or audio under 12 h) and not heavy. */
export function isLight(len: BookLength, moods: string[]): boolean {
  if (isHeavy(len, moods)) return false
  return (len.pages !== null && len.pages < WHAT_NEXT.lightPages) || (len.audioSec !== null && len.audioSec < WHAT_NEXT.lightAudioSec)
}

export function lightMoodScore(moods: string[]): number {
  return moods.filter((m) => (WHAT_NEXT.lightMoods as readonly string[]).includes(m)).length
}

/** Two or more books of the series read, none rated below 3; unrated ones count as read and don't block. */
export function isHooked(readInSeries: { rating: number | null }[]): boolean {
  return readInSeries.length >= 2 && readInSeries.every((r) => r.rating === null || r.rating >= 3)
}

export function preselectMood(input: { lastFinished: { heavy: boolean } | null; nextInSeries: { hooked: boolean } | null }): WhatNextMood {
  const { lastFinished, nextInSeries } = input
  if (lastFinished?.heavy) return nextInSeries?.hooked ? 'keep_going' : 'light'
  return nextInSeries ? 'keep_going' : 'surprise'
}

/** Three or more works read, or two or more whose rated ones average 4 or better. */
export function isFavoriteAuthor(reads: { rating: number | null }[]): boolean {
  if (reads.length >= 3) return true
  const rated = reads.flatMap((r) => (r.rating === null ? [] : [r.rating]))
  return reads.length >= 2 && rated.length > 0 && rated.reduce((a, b) => a + b, 0) / rated.length >= 4
}

/** The smallest whole position after the highest one read; a fractional one (a novella) only when no whole one follows. */
export function nextPosition(readPositions: number[], available: number[]): number | null {
  const after = available.filter((p) => p > Math.max(...readPositions, -Infinity)).sort((a, b) => a - b)
  return after.find(Number.isInteger) ?? after[0] ?? null
}

export const whatNextPickKinds = workKinds

/** Only http(s) links survive: the page renders this as a link, so javascript: and data: values become null. */
function httpUrlOrNull(v: string | null | undefined): string | null {
  if (!v) return null
  try {
    const { protocol } = new URL(v)
    return protocol === 'http:' || protocol === 'https:' ? v : null
  } catch {
    return null
  }
}

export const AiPick = z
  .object({
    title: z.string().trim().min(1).max(500),
    authors: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    // an unknown kind is still a usable pick: read it as a plain book ("Fan fiction" and "Web-Serial" are still those kinds)
    kind: z.preprocess((k) => (typeof k === 'string' ? whatNextPickKinds.find((kind) => kind.replace(/_/g, '') === k.toLowerCase().replace(/[\s_-]+/g, '')) : k), z.enum(whatNextPickKinds)).catch('book'),
    series: z.string().trim().max(300).nullish().transform((v) => v || null),
    position: z.number().nullish().transform((v) => v ?? null),
    url: z.string().trim().max(2000).nullish().transform(httpUrlOrNull),
    format_note: z.string().trim().max(300).nullish().transform((v) => v || null),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine((p) => p.kind === 'book' || p.url !== null, { message: 'fanfiction and web serials need a link', path: ['url'] })
export type AiPick = z.output<typeof AiPick>

const NO_PICKS = "Couldn't find the list in that answer: expected a JSON array of picks like [{\"title\": …, \"authors\": […], \"reason\": …}]. Paste the whole reply"

/** `alreadyRead`: items the person has read; `unusable`: items that are not a complete pick (junk, no reason, no link for fanfiction). */
export function parseWhatNextAnswer(text: string, read: { title: string; authors: string[] }[]): Result<{ picks: AiPick[]; alreadyRead: number; unusable: number }, string> {
  if (text.length > SHELF_MAX_ANSWER) return err('That answer is too long to read: paste only the JSON array')
  const list = jsonArrayIn(text)
  if (list === null) return err(NO_PICKS)
  const picks: AiPick[] = []
  let alreadyRead = 0
  let unusable = 0
  for (const value of list) {
    const parsed = AiPick.safeParse(value)
    if (!parsed.success) unusable++
    else if (read.some((r) => sameTitleAndAuthor(r, { title: parsed.data.title, authors: parsed.data.authors }))) alreadyRead++
    else picks.push(parsed.data)
  }
  return ok({ picks: onePerSeries(picks, (p) => p), alreadyRead, unusable })
}

export interface WhatNextPromptInput {
  mood: WhatNextMood
  format: WhatNextFormat
  lastFinished: { title: string; authors: string[]; rating: number | null } | null
  seriesInProgress: { series: string; nextPosition: number | null }[]
  favoriteAuthors: string[]
  topRated: { title: string; authors: string[]; rating: number }[]
  read: { title: string; authors: string[] }[]
}

const MOOD_TEXT: Record<WhatNextMood, string> = {
  keep_going: 'Keep going: continue a series I am in.',
  light: 'Something light: shorter and easier than what I just finished.',
  surprise: 'Surprise me: something I would not pick myself.',
}

const bookLine = (b: { title: string; authors: string[] }) => `${b.title} — ${b.authors.join(', ')}`

export function buildWhatNextPrompt(input: WhatNextPromptInput): string {
  const lines: string[] = []
  lines.push(`You are recommending what I should read next. Suggest up to ${WHAT_NEXT.maxPerList * 2} books I have not read.`)
  lines.push('', `Mood: ${MOOD_TEXT[input.mood]}`)
  if (input.format === 'audio') {
    lines.push('Format: audio. Please prefer books that have an audiobook, but keep fanfiction and web serials regardless: I sometimes narrate those myself.')
  } else {
    lines.push('Format: any.')
  }
  if (input.lastFinished) {
    const { title, authors, rating } = input.lastFinished
    lines.push('', `The book I just finished: ${bookLine({ title, authors })}${rating === null ? ' (not rated)' : ` (I rated it ${rating} out of 5)`}`)
  }
  if (input.seriesInProgress.length > 0) {
    lines.push('', 'Series I am in:')
    for (const s of input.seriesInProgress) lines.push(`- ${s.series}${s.nextPosition === null ? '' : ` (next is book ${s.nextPosition})`}`)
  }
  if (input.favoriteAuthors.length > 0) lines.push('', `My favorite authors: ${input.favoriteAuthors.join('; ')}`)
  const top = input.topRated.slice(0, WHAT_NEXT.promptTopRated)
  if (top.length > 0) {
    lines.push('', 'My top-rated books:')
    for (const b of top) lines.push(`- ${bookLine(b)} (${b.rating})`)
  }
  const shown = input.read.slice(0, WHAT_NEXT.promptReadCap)
  lines.push('', 'Books I have already read (do not suggest these), newest first:')
  for (const b of shown) lines.push(`- ${bookLine(b)}`)
  const left = input.read.length - shown.length
  if (left > 0) lines.push(`(${left} older books I have read are not listed; please avoid obvious classics and well-known books by the authors above.)`)
  const example = [
    { title: 'The Way of Kings', authors: ['Brandon Sanderson'], kind: 'book', series: 'The Stormlight Archive', position: 1, url: null, format_note: 'audiobook on Audible', reason: 'Epic fantasy in the vein of the series you loved.' },
  ]
  lines.push(
    '',
    "At most one book per series. For a series I haven't started, suggest book 1.",
    '',
    'Search the web, Reddit and fanfiction archives (AO3, FanFiction.net, Royal Road) when that helps. Fanfiction and web serials are welcome, with a link. Give one sentence of reason per pick.',
    '',
    'Answer with only one json code block containing an array like this, and nothing else:',
    '```json',
    JSON.stringify(example, null, 2),
    '```',
    '"kind" is "book", "fanfiction" or "web_serial"; "url" is required for fanfiction and web serials, otherwise null; "series", "position" and "format_note" are null when unknown.',
  )
  return lines.join('\n')
}

/**
 * The one Hardcover series that stands for a local series: the entry whose name equals the local one, else one that contains
 * or is contained in it, else the first featured entry. Never a whole universe ("The Cosmere" beside "The Mistborn Saga").
 */
export function pickHardcoverSeries(localName: string, entries: HardcoverBookSeries[]): HardcoverBookSeries | null {
  const local = normalizeText(localName)
  const named = entries.map((e) => ({ e, name: normalizeText(e.name) })).filter((x) => x.name !== '' && local !== '')
  const hit = named.find((x) => x.name === local) ?? named.find((x) => x.name.includes(local) || local.includes(x.name))
  return hit?.e ?? entries.find((e) => e.featured) ?? null
}

/**
 * At most one item per series (the name compared as normalizeText does), the one with the lowest position: a null position
 * loses to any number and a tie keeps the earlier item. Items without a series are all kept; the list order is kept.
 */
export function onePerSeries<T>(items: T[], of: (item: T) => { series: string | null; position: number | null }): T[] {
  const best = new Map<string, number>()
  items.forEach((item, i) => {
    const { series, position } = of(item)
    const key = series === null ? '' : normalizeText(series)
    if (key === '') return
    const current = best.get(key)
    const currentPosition = current === undefined ? null : of(items[current] as T).position
    if (current === undefined || (position !== null && (currentPosition === null || position < currentPosition))) best.set(key, i)
  })
  const winners = new Set(best.values())
  return items.filter((item, i) => {
    const { series } = of(item)
    return series === null || normalizeText(series) === '' || winners.has(i)
  })
}

/**
 * The lowest-positioned main entry of a series (a whole position of 1 or more: never a prequel or novella) the person has not read,
 * when it comes before the pick; null when the pick is itself the first unread.
 */
export function firstUnreadBook(books: { title: string; position: number | null; positionEnd?: number | null; read: boolean }[], pickPosition: number | null): { title: string; position: number } | null {
  if (pickPosition === null) return null
  // a position counts as read when any entry at it is (Hardcover can list a box set or a second edition beside the book)
  // a read box set covers every whole position of its range
  const readAt = new Set<number>()
  for (const b of books) {
    if (!b.read || b.position === null) continue
    readAt.add(b.position)
    for (let p = Math.ceil(b.position); p <= (b.positionEnd ?? b.position); p++) readAt.add(p)
  }
  let first: { title: string; position: number } | null = null
  for (const b of books) {
    if (b.read || (b.position !== null && readAt.has(b.position)) || b.position === null || !Number.isInteger(b.position) || b.position < 1 || b.position >= pickPosition) continue
    if (first === null || b.position < first.position) first = { title: b.title, position: b.position }
  }
  return first
}
