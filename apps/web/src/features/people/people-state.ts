import { defaultPrimaryName, prefillNameLanguage } from '@mylib/domain'

interface DraftPerson {
  names: { id: string; language: string | null; primary: boolean }[]
  books: { nameId: string | null; language: string | null }[]
  bookCount: number
}

/** The merge dialog's starting choices (spec "Same person as…"): primary name and each name's language. */
export function mergeDraft(opened: DraftPerson, other: DraftPerson): { primaryNameId: string; languages: Record<string, string | null> } {
  const primaryOf = (p: DraftPerson) => p.names.find((n) => n.primary)?.id ?? p.names[0]?.id ?? ''
  const languages: Record<string, string | null> = {}
  for (const p of [opened, other]) {
    for (const n of p.names) languages[n.id] = prefillNameLanguage(n.language, p.books.filter((b) => b.nameId === n.id).map((b) => b.language))
  }
  return { primaryNameId: defaultPrimaryName({ primaryNameId: primaryOf(opened), bookCount: opened.bookCount }, { primaryNameId: primaryOf(other), bookCount: other.bookCount }), languages }
}

export function peopleSummary(p: { authorOf: number; translatorOf: number; narratorOf: number; illustratorOf: number }): string {
  const parts = [
    p.authorOf > 0 ? `Author of ${String(p.authorOf)}` : null,
    p.translatorOf > 0 ? `Translator of ${String(p.translatorOf)}` : null,
    p.narratorOf > 0 ? `Narrator of ${String(p.narratorOf)}` : null,
    p.illustratorOf > 0 ? `Illustrator of ${String(p.illustratorOf)}` : null,
  ].filter((s): s is string => s !== null)
  return parts.length === 0 ? 'No books' : parts.join(' · ')
}

/** A native option cannot style a muted hint, so the other names follow in parentheses (ruling 7). */
export function filterOptionLabel(a: { name: string; otherNames: readonly string[] }): string {
  return a.otherNames.length === 0 ? a.name : `${a.name} (${a.otherNames.join(', ')})`
}
