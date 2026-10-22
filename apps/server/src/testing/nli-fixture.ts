import english from '../../../../packages/domain/src/providers/fixtures/nli-isbn-english.json'
import hebrew from '../../../../packages/domain/src/providers/fixtures/nli-isbn-hebrew.json'

export const NLI_TEST_URL = 'https://nli.test/openlibrary/search'
export const NLI_TEST_KEY = 'test-nli-key'
export let nliFetches: string[] = []
export const resetNliFetches = () => {
  nliFetches = []
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

/** The National Library's search API: the Hebrew book by its ISBN-13 or record id, the English one by its ISBN-10. */
export function nliFixtureFetch() {
  return (url: string): Promise<Response> => {
    nliFetches.push(url)
    const u = new URL(url)
    if (u.searchParams.get('api_key') !== NLI_TEST_KEY) return Promise.resolve(new Response(null, { status: 403 }))
    const query = u.searchParams.get('query') ?? ''
    if (query === 'any,contains,down') return Promise.resolve(new Response(null, { status: 502 }))
    if (query === 'any,contains,9789655310320' || query === 'any,contains,990026932820205171') return json(hebrew)
    if (query === 'any,contains,0747538484') return json(english)
    // a book whose record holds only its 10-digit ISBN (Open Library's fake doesn't know it)
    if (query === 'any,contains,0140328726') return json(english.map((r) => ({ ...r, 'http://purl.org/dc/elements/1.1/isbn': [{ '@value': '0140328726' }] })))
    return json([])
  }
}
