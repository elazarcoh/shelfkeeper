import { z } from 'zod'
import { romanNumber, seriesPosition } from './numerals'

export const MAX_VOLUME = 999

/** An imported item's volume: "vol 2 of 3". The count is null when unknown, or when it was below the number. */
export const ItemVolume = z
  .object({ number: z.number().int().min(1).max(MAX_VOLUME), count: z.number().int().min(1).max(MAX_VOLUME).nullable() })
  .transform((v) => (v.count !== null && v.count < v.number ? { ...v, count: null } : v))
export type ItemVolume = z.output<typeof ItemVolume>

/** "2", "ב'", "שלישי", "IV" → a volume number 1..999; anything else → null. */
export function volumeNumber(token: string): number | null {
  const t = token.replace(/[()[\].,]/g, '').trim()
  const n = /^[ivxlcdm]+$/i.test(t) ? romanNumber(t) : seriesPosition(t)
  return n !== null && Number.isInteger(n) && n >= 1 && n <= MAX_VOLUME ? n : null
}

const SEP = String.raw`[\s\-–—:,(\[]`
const END = String.raw`\s*[)\]]?\s*$`
// a trailing marker: "… - כרך א'", "… (כרך ב' מתוך 3)"; the word must start the marker (so "הספר" is not "ספר")
const HEBREW = new RegExp(String.raw`(?:^|${SEP})\s*(?:כרך|חלק|ספר)\s+([^\s()[\]]+)(?:\s+מתוך\s+([^\s()[\]]+))?${END}`, 'u')
// "…, Part 2 of 3", "… Vol. II", "… (Volume 3)": a number or roman numeral must follow the word
const ENGLISH = new RegExp(String.raw`(?:^|${SEP})\s*(?:vol\.?|volume|part)\s*(\d{1,4}|[ivxlcdm]+)(?:\s+of\s+(\d{1,4}|[ivxlcdm]+))?${END}`, 'iu')
// "Book 2" alone is a series position ("Mistborn, Book 2"), not a volume: only "Book 2 of 3" is
const ENGLISH_BOOK = new RegExp(String.raw`(?:^|${SEP})\s*book\s*(\d{1,4}|[ivxlcdm]+)\s+of\s+(\d{1,4}|[ivxlcdm]+)${END}`, 'iu')
const TRAILING_SEP = /[\s\-–—:,([]+$/u

/** A volume marker at the end of a title or subtitle, and the text without it ('' when the marker was all there was). */
export function parseVolumeMarker(text: string): { title: string; volume: number; count: number | null } | null {
  for (const pattern of [HEBREW, ENGLISH, ENGLISH_BOOK]) {
    const m = pattern.exec(text)
    if (m === null || m[1] === undefined) continue
    const volume = volumeNumber(m[1])
    if (volume === null) continue
    const count = m[2] === undefined ? null : volumeNumber(m[2])
    return { title: text.slice(0, m.index).replace(TRAILING_SEP, '').trim(), volume, count: count !== null && count >= volume ? count : null }
  }
  return null
}

const MARKER_WORD = /^(?:כרך|חלק|ספר|vol\.?|volume|part|book)\s*/iu

/** A volume column or AI field: "2", "כרך ב'", "2 of 3", "2/3", "א' מתוך 2". */
export function parseVolumeText(text: string | null): ItemVolume | null {
  if (text === null) return null
  const core = text.trim().replace(MARKER_WORD, '')
  if (core === '') return null
  const parts = core.split(/\s*(?:\/|\bof\b|מתוך)\s*/iu)
  if (parts.length > 2 || parts[0] === undefined) return null
  const number = volumeNumber(parts[0])
  if (number === null) return null
  const count = parts[1] === undefined ? null : volumeNumber(parts[1])
  return { number, count: count !== null && count >= number ? count : null }
}

/** What every importer does: a marker on the title (or else the subtitle) becomes the volume, and leaves the text. */
export function volumeFromTitles(title: string, subtitle: string | null): { title: string; subtitle: string | null; volume: ItemVolume | null } {
  const t = parseVolumeMarker(title)
  if (t !== null && t.title !== '') return { title: t.title, subtitle, volume: { number: t.volume, count: t.count } }
  const s = subtitle === null ? null : parseVolumeMarker(subtitle)
  if (s !== null) return { title, subtitle: s.title === '' ? null : s.title, volume: { number: s.volume, count: s.count } }
  return { title, subtitle, volume: null }
}

/** The title and subtitle as imported, when stripping the marker changed them; null otherwise. */
export function importedTitleOf(title: string, subtitle: string | null, marked: { title: string; subtitle: string | null }): { title: string; subtitle: string | null } | null {
  return marked.title === title && marked.subtitle === subtitle ? null : { title, subtitle }
}
