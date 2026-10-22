/**
 * Infinite scroll helpers. Two shapes:
 * - offset pages (the Library): each page is asked for `pageSize` entries from where the last one stopped;
 * - a growing limit (the Inbox): one list asked for more each time, since resolving a card drops it from the list and
 *   an offset would then skip the card that moved up into its place.
 */

/** The offset of the next page, or undefined when every entry is loaded (or a page came back short). */
export function nextOffset(pages: readonly { items: readonly unknown[]; total: number }[], pageSize: number): number | undefined {
  const last = pages.at(-1)
  if (last === undefined || last.items.length < pageSize) return undefined
  const loaded = pages.length * pageSize
  return loaded < last.total ? loaded : undefined
}

/** Every page's entries in order, each once: a book added or removed between pages can shift one into the next. */
export function uniqueItems<T>(pages: readonly { items: readonly T[] }[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const page of pages) {
    for (const item of page.items) {
      const k = key(item)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(item)
    }
  }
  return out
}

/** A list asked for `limit` entries that came back full may have more: the next, larger limit; else null. */
export function nextLimit(shown: number, limit: number, step: number): number | null {
  return shown >= limit ? limit + step : null
}
