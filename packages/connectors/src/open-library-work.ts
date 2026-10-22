import { extractPage, providerById, type PageCapture } from '@mylib/domain'
import type { HttpClient } from './http'

// Open Library asks API clients to name themselves (the same text the server's shelf router sends)
const API_UA = 'MyLibrary/1.0 (self-hosted home library; +https://github.com/elazarcoh/my-library)'
const TIMEOUT_MS = 10_000

/**
 * An Open Library work's title and authors. For a translated edition these are the original's: Open Library keeps
 * translations under their work (#72). A cached capture saves the request; any failure is null.
 */
export async function openLibraryWork(http: HttpClient, id: string, cached: PageCapture | null): Promise<{ title: string; authors: string[] } | null> {
  const provider = providerById('openlibrary')
  let capture = cached
  if (capture === null) {
    const body = await http.getText(provider.fetch.url(id), { accept: provider.fetch.accept, 'user-agent': API_UA }, undefined, TIMEOUT_MS)
    if (!body.ok) return null
    capture = provider.fetch.capture(body.value, provider.canonicalUrl(id), null)
  }
  if (capture === null) return null
  const page = extractPage(capture)
  return page.ok ? { title: page.value.title, authors: page.value.authors } : null
}
