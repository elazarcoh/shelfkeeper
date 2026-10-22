import { describe, expect, it } from 'vitest'
import { fetchSameOrigin } from './connector'
import { createHttpClient } from './http'

describe('fetchSameOrigin', () => {
  const seen: string[] = []
  const http = createHttpClient({
    fetch: (url, init) => {
      seen.push(`${url} ${init.headers['x-api-key'] ?? ''}`)
      return Promise.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0])))
    },
  })

  it('resolves a relative cover path against the source and sends its credentials', async () => {
    seen.length = 0
    const result = await fetchSameOrigin(http, 'http://readarr:8787', '/MediaCover/Books/1/cover.jpg?lastWrite=1', { 'x-api-key': 'k' })
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['http://readarr:8787/MediaCover/Books/1/cover.jpg?lastWrite=1 k'])
  })

  it('refuses a cover on another host', async () => {
    seen.length = 0
    const result = await fetchSameOrigin(http, 'http://readarr:8787', 'https://images.gr-assets.com/books/1.jpg', { 'x-api-key': 'k' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error', message: 'The cover is not on this source\'s server' } })
    expect(seen).toEqual([])
  })

  it('rejects redirects to prevent credentials leaking to other hosts', async () => {
    const result = await fetchSameOrigin(
      createHttpClient({
        fetch: () => Promise.resolve(new Response('', { status: 302, headers: { location: 'https://evil.com/hijack' } })),
      }),
      'http://readarr:8787',
      '/MediaCover/Books/1/cover.jpg',
      { 'x-api-key': 'secret' },
    )
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } })
  })
})
