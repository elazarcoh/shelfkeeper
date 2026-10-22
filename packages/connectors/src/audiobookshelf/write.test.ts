import { describe, expect, it } from 'vitest'
import { createHttpClient, type FetchLike } from '../http'
import { ABS_FIXTURE_TOKEN } from '../testing'
import { fetchAbsItem, patchAbsMedia } from './write'

const config = { kind: 'audiobookshelf' as const, baseUrl: 'http://abs.local', apiToken: ABS_FIXTURE_TOKEN, libraryIds: null }

function recorder() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | undefined }[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return Promise.resolve(Response.json({ updated: true }))
  }
  return { http: createHttpClient({ fetch }), calls }
}

describe('Audiobookshelf writes', () => {
  it('patchAbsMedia PATCHes /api/items/<id>/media with the bearer key', async () => {
    const { http, calls } = recorder()
    const result = await patchAbsMedia(config, http, 'li a/b', { title: 'T', authors: [{ name: 'A' }] })
    expect(result).toEqual({ ok: true, value: undefined })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://abs.local/api/items/li%20a%2Fb/media')
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.headers['authorization']).toBe('Bearer fixture-token')
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ metadata: { title: 'T', authors: [{ name: 'A' }] } })
  })

  it('patchAbsMedia passes a 403 through as unauthorized', async () => {
    const http = createHttpClient({ fetch: () => Promise.resolve(new Response('no', { status: 403 })) })
    expect(await patchAbsMedia(config, http, 'li_1', {})).toMatchObject({ ok: false, error: { kind: 'unauthorized', status: 403 } })
  })

  it('fetchAbsItem reads ?expanded=1', async () => {
    const { http, calls } = recorder()
    await fetchAbsItem(config, http, 'li_1')
    expect(calls[0]).toMatchObject({ url: 'http://abs.local/api/items/li_1?expanded=1', method: 'GET' })
    expect(calls[0]?.headers['authorization']).toBe('Bearer fixture-token')
  })
})
