import { normalizeText } from '@mylib/domain'

/** How a field holds names: one name, one per line, or comma separated. */
export type SuggestMode = 'single' | 'lines' | 'comma'

/** The item under the caret: its raw range in the value, and its trimmed text. */
export interface Segment {
  start: number
  end: number
  text: string
}

const SEPARATOR: Record<SuggestMode, string | null> = { single: null, lines: '\n', comma: ',' }

export function currentSegment(value: string, caret: number, mode: SuggestMode): Segment {
  const sep = SEPARATOR[mode]
  const at = Math.max(0, Math.min(caret, value.length))
  const start = sep === null || at === 0 ? 0 : value.lastIndexOf(sep, at - 1) + 1
  const next = sep === null ? -1 : value.indexOf(sep, at)
  const end = next === -1 ? value.length : next
  return { start, end, text: value.slice(start, end).trim() }
}

export function splitItems(value: string, mode: SuggestMode): string[] {
  const sep = SEPARATOR[mode]
  return (sep === null ? [value] : value.split(sep)).map((s) => s.trim()).filter((s) => s !== '')
}

export function otherItems(value: string, caret: number, mode: SuggestMode): string[] {
  if (mode === 'single') return []
  const { start, end } = currentSegment(value, caret, mode)
  return [...splitItems(value.slice(0, start), mode), ...splitItems(value.slice(end), mode)]
}

/** The option names normalized once, so a keystroke only has to normalize the query. */
export interface OptionIndex {
  names: readonly string[]
  normalized: readonly string[]
  set: ReadonlySet<string>
}

export function indexOptions(options: readonly string[]): OptionIndex {
  const normalized = options.map(normalizeText)
  return { names: options, normalized, set: new Set(normalized) }
}

const asIndex = (options: readonly string[] | OptionIndex): OptionIndex => (Array.isArray(options) ? indexOptions(options) : (options as OptionIndex))

/** Ranked: the name starts with the query, then a later word does, then it contains it. Ties keep list order. */
export function matchOptions(query: string, options: readonly string[] | OptionIndex, exclude: readonly string[] = [], limit = 8): string[] {
  const q = normalizeText(query)
  if (q === '') return []
  const { names, normalized } = asIndex(options)
  const skip = new Set([q, ...exclude.map(normalizeText)])
  const ranked: { name: string; rank: number; index: number }[] = []
  names.forEach((name, index) => {
    const n = normalized[index] ?? ''
    if (skip.has(n)) return
    const rank = n.startsWith(q) ? 0 : n.includes(` ${q}`) ? 1 : n.includes(q) ? 2 : -1
    if (rank >= 0) ranked.push({ name, rank, index })
  })
  return ranked
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.name)
}

/** Replaces only the segment; in comma mode the next item can be typed right away. */
export function applyPick(value: string, segment: Segment, pick: string, mode: SuggestMode): { value: string; caret: number } {
  const before = value.slice(0, segment.start)
  const after = value.slice(segment.end)
  const inserted = mode === 'comma' ? `${before === '' ? '' : ' '}${pick}${after === '' ? ', ' : ''}` : pick
  return { value: before + inserted + after, caret: before.length + inserted.length }
}

export function isNew(item: string, options: readonly string[] | OptionIndex): boolean {
  const n = normalizeText(item)
  return n !== '' && !asIndex(options).set.has(n)
}

export function newItems(value: string, mode: SuggestMode, options: readonly string[] | OptionIndex): string[] {
  const index = asIndex(options)
  const seen = new Set<string>()
  return splitItems(value, mode).filter((item) => {
    const n = normalizeText(item)
    if (n === '' || seen.has(n) || index.set.has(n)) return false
    seen.add(n)
    return true
  })
}

export function newNote(label: string, items: readonly string[], mode: SuggestMode): string {
  return mode === 'single' ? `${label} — will be created` : `${label}: ${items.map((i) => `"${i}"`).join(', ')} — will be created`
}

export function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const n = normalizeText(name)
  return n === '' ? undefined : items.find((item) => normalizeText(item.name) === n)
}
