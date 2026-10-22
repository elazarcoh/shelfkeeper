import { pageFromText, parseShelfAnswer, shelfAnswerFormat } from '@mylib/domain'

/** The manifest's share_target sends these as query parameters of /books/shelf. */
export const SHARE_PARAMS = ['title', 'text', 'url'] as const

/** What was shared to the app: the AI's answer to read, or a book page's link to open. */
export type Shared = { kind: 'answer'; text: string } | { kind: 'link'; text: string }

/**
 * Reads a share from the address. An AI's answer wins over a link (a list may hold links in its notes); text that is
 * neither still goes to the answer box, where reading it explains what is wrong.
 */
export function sharedFromSearch(search: string): Shared | null {
  const params = new URLSearchParams(search)
  const parts = SHARE_PARAMS.map((p) => params.get(p)?.trim() ?? '').filter((p) => p !== '')
  if (parts.length === 0) return null
  const answer = parts.find((p) => shelfAnswerFormat(p) !== null || parseShelfAnswer(p).ok)
  if (answer !== undefined) return { kind: 'answer', text: answer }
  const link = parts.find((p) => pageFromText(p) !== null)
  if (link !== undefined) return { kind: 'link', text: link }
  // a share sheet often puts the page title in `title` and the rest in `text`: the longest part is the content
  return { kind: 'answer', text: parts.reduce((a, b) => (b.length > a.length ? b : a)) }
}
