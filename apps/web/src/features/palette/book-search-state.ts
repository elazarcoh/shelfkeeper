import { tokenize } from '@mylib/domain'

/**
 * True while the Books group for `query` is still on its way: the debounce has not caught up with the input yet,
 * or the (enabled) search for the settled query is in flight. "No matches" must wait for this to be false.
 */
export function bookSearchPending(query: string, settled: string, fetching: boolean): boolean {
  if (tokenize(query).length === 0) return false
  if (settled !== query) return true
  return fetching
}
