import { describe, expect, it } from 'vitest'
import { createHttpClient, type FetchLike } from './http'

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) })
    return respond(url)
  }
  return { fetch, calls }
}

describe('http client', () => {
  it('GETs JSON with the given headers', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ hello: 'world' }))
    const http = createHttpClient({ fetch })
    expect(await http.getJson('http://abs.local/api/x', { authorization: 'Bearer t' })).toEqual({ ok: true, value: { hello: 'world' } })
    expect(calls).toEqual([{ url: 'http://abs.local/api/x', method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer t' } }])
  })

  it('patchJson sends PATCH with a JSON body', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ updated: true }))
    const http = createHttpClient({ fetch })
    const body = { metadata: { title: 'T' } }
    expect(await http.patchJson('http://abs.local/api/x', body, { authorization: 'Bearer t' })).toEqual({ ok: true, value: { updated: true } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.body).toBe(JSON.stringify(body))
    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(calls[0]?.headers['authorization']).toBe('Bearer t')
  })

  it('patchJson maps 403 to unauthorized', async () => {
    const http = createHttpClient({ fetch: fakeFetch(() => new Response('no', { status: 403 })).fetch })
    expect(await http.patchJson('http://abs.local/api/x', {})).toMatchObject({ ok: false, error: { kind: 'unauthorized', status: 403 } })
  })

  it('patchJson accepts an empty 200 body', async () => {
    const http = createHttpClient({ fetch: fakeFetch(() => new Response('', { status: 200 })).fetch })
    expect(await http.patchJson('http://abs.local/api/x', {})).toEqual({ ok: true, value: null })
  })

  it.each([
    [301, 'provider_error'],
    [302, 'provider_error'],
    [303, 'provider_error'],
    [307, 'provider_error'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
    [404, 'provider_error'],
  ] as const)('maps HTTP %i to %s and keeps the status', async (status, kind) => {
    const http = createHttpClient({ fetch: fakeFetch(() => new Response('nope', { status })).fetch })
    const result = await http.getJson('http://abs.local/api/x')
    expect(result).toMatchObject({ ok: false, error: { kind, status } })
  })

  it('rejects redirects on getJson and never follows them', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 302, headers: { location: 'https://evil.com' } }))
    const http = createHttpClient({ fetch })
    const result = await http.getJson('http://abs.local/api/x', { 'x-api-key': 'secret' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error', message: 'Source redirected; update the base URL' } })
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('reports a network failure as unreachable without leaking headers', async () => {
    const http = createHttpClient({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) })
    const result = await http.getJson('http://abs.local:13378/api/x', { authorization: 'Bearer secret-token' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'unreachable', status: null } })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('reports a non-JSON body as a schema mismatch', async () => {
    const http = createHttpClient({ fetch: fakeFetch(() => new Response('<html>', { status: 200 })).fetch })
    expect(await http.getJson('http://abs.local/api/x')).toMatchObject({ ok: false, error: { kind: 'schema_mismatch' } })
  })

  it('handles an invalid URL as provider_error', async () => {
    const http = createHttpClient()
    const result = await http.getJson('not a url')
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error', status: null } })
  })

  it('aborts and reports timeout as unreachable', async () => {
    const fetch: FetchLike = async (url, init) => {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'))
        })
      })
    }
    const http = createHttpClient({ fetch, timeoutMs: 20 })
    const result = await http.getJson('http://abs.local/api/x')
    expect(result).toMatchObject({ ok: false, error: { kind: 'unreachable', status: null } })
  })

  describe('getBytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    it('returns the body bytes and content type', async () => {
      const http = createHttpClient({ fetch: () => Promise.resolve(new Response(png, { headers: { 'content-type': 'image/png' } })) })
      expect(await http.getBytes('http://abs.test/cover')).toEqual({ ok: true, value: { bytes: png, contentType: 'image/png' } })
    })
    it('refuses a body larger than the limit', async () => {
      const http = createHttpClient({ fetch: () => Promise.resolve(new Response(new Uint8Array(20))) })
      expect(await http.getBytes('http://abs.test/cover', {}, 10)).toMatchObject({ ok: false, error: { kind: 'provider_error', message: 'abs.test sent a file larger than 10 bytes' } })
    })
    it('maps 401 like getJson', async () => {
      const http = createHttpClient({ fetch: () => Promise.resolve(new Response('no', { status: 401 })) })
      expect(await http.getBytes('http://abs.test/cover')).toMatchObject({ ok: false, error: { kind: 'unauthorized', status: 401 } })
    })
    it('rejects redirects to prevent same-origin bypass', async () => {
      const http = createHttpClient({ fetch: () => Promise.resolve(new Response('', { status: 302, headers: { location: 'https://other.host/cover.jpg' } })) })
      expect(await http.getBytes('http://abs.test/cover')).toMatchObject({ ok: false, error: { kind: 'provider_error', message: 'Redirects to covers are not allowed' } })
    })
    it('follows only the redirect hops it is allowed, at most three', async () => {
      const hops: Record<string, string> = { 'https://a.test/1': '/2', 'https://a.test/2': 'https://b.test/3', 'https://b.test/3': 'https://b.test/4', 'https://b.test/4': 'https://b.test/5' }
      const seen: string[] = []
      const http = createHttpClient({
        fetch: (url) => {
          seen.push(url)
          const next = hops[url]
          return Promise.resolve(next === undefined ? new Response(png, { headers: { 'content-type': 'image/png' } }) : new Response(null, { status: 302, headers: { location: next } }))
        },
      })
      const allowed: [string, string][] = []
      const allow = (from: string, to: string) => {
        allowed.push([from, to])
        return !to.includes('evil')
      }
      expect(await http.getBytes('https://a.test/2', {}, 100, allow)).toMatchObject({ ok: true, value: { bytes: png } })
      expect(seen).toEqual(['https://a.test/2', 'https://b.test/3', 'https://b.test/4', 'https://b.test/5'])
      expect(allowed[0]).toEqual(['https://a.test/2', 'https://b.test/3'])
      seen.length = 0
      // four hops: the fourth is refused
      expect(await http.getBytes('https://a.test/1', {}, 100, allow)).toMatchObject({ ok: false, error: { message: 'Redirects to covers are not allowed' } })
      expect(seen).toHaveLength(4)
      hops['https://a.test/9'] = 'https://evil.test/x'
      expect(await http.getBytes('https://a.test/9', {}, 100, allow)).toMatchObject({ ok: false, error: { message: 'Redirects to covers are not allowed' } })
      expect(await http.getBytes('https://a.test/9')).toMatchObject({ ok: false, error: { message: 'Redirects to covers are not allowed' } })
    })
    it('streams and rejects a body larger than maxBytes without content-length', async () => {
      const largeData = new Uint8Array(20)
      const http = createHttpClient({
        fetch: () => Promise.resolve(new Response(largeData, { headers: { /* no content-length */ } })),
      })
      expect(await http.getBytes('http://abs.test/cover', {}, 10)).toMatchObject({ ok: false, error: { kind: 'provider_error', message: 'abs.test sent a file larger than 10 bytes' } })
    })
    it('streams and accepts a body under the cap', async () => {
      const data = new Uint8Array([1, 2, 3])
      const http = createHttpClient({
        fetch: () => Promise.resolve(new Response(data, { headers: { 'content-type': 'image/png' } })),
      })
      expect(await http.getBytes('http://abs.test/cover', {}, 10)).toEqual({ ok: true, value: { bytes: data, contentType: 'image/png' } })
    })
    it('returns unreachable when stream errors mid-download', async () => {
      const errorStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.error(new Error('Network error'))
        },
      })
      const http = createHttpClient({
        fetch: () => Promise.resolve(new Response(errorStream, { headers: { 'content-type': 'image/png' } })),
      })
      const result = await http.getBytes('http://abs.test/cover')
      expect(result).toMatchObject({ ok: false, error: { kind: 'unreachable', status: null } })
    })
  })

  it('asks for JSON and for images the same way: GET, no redirects, a timeout', async () => {
    const inits: { method: string; redirect: string | undefined; hasSignal: boolean; accept: string | undefined }[] = []
    const http = createHttpClient({
      fetch: (_url, init) => {
        inits.push({ method: init.method, redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal, accept: init.headers.accept })
        return Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/json' } }))
      },
    })
    await http.getJson('http://abs.test/api')
    await http.getBytes('http://abs.test/cover')
    expect(inits).toEqual([
      { method: 'GET', redirect: 'manual', hasSignal: true, accept: 'application/json' },
      { method: 'GET', redirect: 'manual', hasSignal: true, accept: 'image/*' },
    ])
  })

  it('maps 429 and other failures the same way for images as for JSON', async () => {
    for (const status of [429, 500]) {
      const http = createHttpClient({ fetch: () => Promise.resolve(new Response('x', { status })) })
      const json = await http.getJson('http://abs.test/api')
      const bytes = await http.getBytes('http://abs.test/cover')
      expect(bytes).toEqual(json)
    }
  })

  it('getText reads a page as text and refuses redirects and oversized bodies', async () => {
    const http = createHttpClient({
      fetch: (url) => Promise.resolve(url.endsWith('/r') ? new Response(null, { status: 302, headers: { location: 'https://x' } }) : new Response('<html>שלום</html>', { status: 200 })),
    })
    expect(await http.getText('https://simania.co.il/a')).toEqual({ ok: true, value: '<html>שלום</html>' })
    expect((await http.getText('https://simania.co.il/r')).ok).toBe(false)
    expect((await http.getText('https://simania.co.il/a', {}, 5)).ok).toBe(false)
  })

  it('getText takes its own timeout for one call', async () => {
    const http = createHttpClient({
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timed out')))),
    })
    expect(await http.getText('https://simania.co.il/slow', {}, undefined, 20)).toMatchObject({ ok: false, error: { kind: 'unreachable' } })
  })
})
