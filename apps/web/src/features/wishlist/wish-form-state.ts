import { editionFormats, type EditionFormat, type WishFields } from '@mylib/domain'
import { languageName } from '@/lib/format'

export type WishDraft = { formats: EditionFormat[]; language: string; note: string }

export function emptyDraft(page?: { language: string | null }): WishDraft {
  return { formats: [], language: page?.language ?? '', note: '' }
}

export function draftFromFields(f: WishFields): WishDraft {
  return { formats: f.formats, language: f.language ?? '', note: f.note ?? '' }
}

export function toggleFormat(d: WishDraft, f: EditionFormat): WishDraft {
  const has = d.formats.includes(f)
  return { ...d, formats: editionFormats.filter((x) => (x === f ? !has : d.formats.includes(x))) }
}

const blankToNull = (s: string) => (s.trim() === '' ? null : s.trim())

export function fieldsFromDraft(d: WishDraft): { formats: EditionFormat[]; language: string | null; note: string | null } {
  return { formats: d.formats, language: blankToNull(d.language), note: blankToNull(d.note) }
}

const formatWord: Record<EditionFormat, string> = { physical: 'physical', ebook: 'ebook', audiobook: 'audiobook' }

/** What a wish asks for: "Physical or audiobook · Hebrew", "Any format". */
export function criteriaLabel(f: { formats: EditionFormat[]; language: string | null }): string {
  const formats = f.formats.length === 0 ? 'Any format' : f.formats.map((x) => formatWord[x]).join(' or ')
  const text = formats.charAt(0).toUpperCase() + formats.slice(1)
  return f.language === null ? text : `${text} · ${languageName(f.language)}`
}

/** What the form shows: the person's edits, else the existing wish, else a blank one; null while the wish is still loading. */
export function seedDraft(edits: WishDraft | null, wish: WishFields | null | undefined): WishDraft | null {
  if (edits !== null) return edits
  if (wish === undefined) return null
  return wish === null ? emptyDraft() : draftFromFields(wish)
}
