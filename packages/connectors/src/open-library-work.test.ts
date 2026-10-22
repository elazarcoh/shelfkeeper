import { describe, expect, it } from 'vitest'
import { createHttpClient } from './http'
import { openLibraryWork } from './open-library-work'

const answer = { docs: [{ key: '/works/OL45W', title: 'The Final Empire', author_name: ['Brandon Sanderson'] }] }

describe('openLibraryWork', () => {
  it('reads the work’s title and authors, fetched once', async () => {
    const urls: string[] = []
    const http = createHttpClient({
      fetch: (url) => {
        urls.push(url)
        return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })
    expect(await openLibraryWork(http, 'OL45W', null)).toEqual({ title: 'The Final Empire', authors: ['Brandon Sanderson'] })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('openlibrary.org/search.json')
  })
  it('uses a cached capture without fetching; a failure is null', async () => {
    const http = createHttpClient({ fetch: () => Promise.reject(new Error('offline')) })
    const cached = {
      url: 'https://openlibrary.org/works/OL45W',
      title: 'The Final Empire',
      ld: [{ '@type': 'Book', url: 'https://openlibrary.org/works/OL45W', name: 'The Final Empire', author: [{ '@type': 'Person', name: 'Brandon Sanderson' }] }],
      meta: {},
    }
    expect(await openLibraryWork(http, 'OL45W', cached)).toEqual({ title: 'The Final Empire', authors: ['Brandon Sanderson'] })
    expect(await openLibraryWork(http, 'OL45W', null)).toBeNull()
  })
})
