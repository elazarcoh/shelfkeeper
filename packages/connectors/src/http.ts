import { err, ok, MAX_COVER_BYTES, type ConnectorError, type Result } from '@mylib/domain'

export type FetchLike = (
  url: string,
  init: { method: 'GET' | 'PATCH'; headers: Record<string, string>; signal: AbortSignal; redirect?: 'manual'; body?: string },
) => Promise<Response>

export type HttpError = ConnectorError & { status: number | null }

/** The only door from a connector to a source. GET only, except `patchJson`, the one write (My Library to Audiobookshelf, #115). */
export interface HttpClient {
  getJson(url: string, headers?: Record<string, string>): Promise<Result<unknown, HttpError>>
  /**
   * A binary GET (covers). Bodies over `maxBytes` are refused. Redirects are refused unless `followRedirect` allows
   * the hop (it sees every hop, at most three).
   */
  getBytes(url: string, headers?: Record<string, string>, maxBytes?: number, followRedirect?: (from: string, to: string) => boolean): Promise<Result<{ bytes: Uint8Array; contentType: string | null }, HttpError>>
  /** An HTML page as UTF-8 text. Redirects are refused and bodies over `maxBytes` too; `timeoutMs` replaces the client's timeout for this call. */
  getText(url: string, headers?: Record<string, string>, maxBytes?: number, timeoutMs?: number): Promise<Result<string, HttpError>>
  /** A JSON PATCH, the one write. A 2xx with an empty or non-JSON body is `ok(null)`. */
  patchJson(url: string, body: unknown, headers?: Record<string, string>): Promise<Result<unknown, HttpError>>
}

export interface HttpClientOptions {
  fetch?: FetchLike
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3
const MAX_PAGE_BYTES = 2_000_000

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** The one door: GET or PATCH, no redirects followed, a timeout, and one mapping of HTTP failures to connector errors. */
  async function request(
    method: 'GET' | 'PATCH',
    body: string | undefined,
    url: string,
    headers: Record<string, string>,
    accept: string,
    redirectMessage: string,
    timeout = timeoutMs,
    followRedirect?: (from: string, to: string) => boolean,
    hops = 0,
  ): Promise<Result<{ response: Response; host: string }, HttpError>> {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return err({ kind: 'provider_error', status: null, message: 'Invalid URL' })
    }
    let response: Response
    try {
      response = await doFetch(url, { method, headers: { accept, ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'manual', ...(body === undefined ? {} : { body }) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return err({ kind: 'unreachable', status: null, message: `Could not reach ${host} (${reason})` })
    }
    const status = response.status
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location')
      let next: string | null = null
      try {
        next = location === null ? null : new URL(location, url).toString()
      } catch {
        next = null
      }
      if (followRedirect !== undefined && next !== null && hops < MAX_REDIRECTS && followRedirect(url, next)) return request(method, body, next, headers, accept, redirectMessage, timeout, followRedirect, hops + 1)
      return err({ kind: 'provider_error', status, message: redirectMessage })
    }
    if (status === 401 || status === 403) return err({ kind: 'unauthorized', status, message: `${host} rejected the credentials` })
    if (status === 429) return err({ kind: 'rate_limited', status, message: `${host} is rate limiting requests — try again later` })
    if (!response.ok) return err({ kind: 'provider_error', status, message: `${host} answered ${status}` })
    return ok({ response, host })
  }

  /** The body, refused as soon as it passes `maxBytes` (a missing or lying content-length changes nothing). */
  async function readLimited(response: Response, host: string, maxBytes: number): Promise<Result<Uint8Array, HttpError>> {
    const tooLarge = err<HttpError>({ kind: 'provider_error', status: response.status, message: `${host} sent a file larger than ${maxBytes} bytes` })
    if (Number(response.headers.get('content-length') ?? '0') > maxBytes) return tooLarge
    const reader = response.body?.getReader()
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      return bytes.byteLength > maxBytes ? tooLarge : ok(bytes)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        const value = chunk.value as Uint8Array
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return tooLarge
        }
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      const reason = error instanceof Error ? error.message : String(error)
      return err({ kind: 'unreachable', status: null, message: `Could not read ${host} (${reason})` })
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return ok(bytes)
  }

  return {
    async getJson(url, headers = {}) {
      const result = await request('GET', undefined, url, headers, 'application/json', 'Source redirected; update the base URL')
      if (!result.ok) return result
      try {
        return ok(await result.value.response.json())
      } catch {
        return err({ kind: 'schema_mismatch', status: result.value.response.status, message: `${result.value.host} did not return JSON` })
      }
    },
    async patchJson(url, body, headers = {}) {
      const result = await request('PATCH', JSON.stringify(body), url, { 'content-type': 'application/json', ...headers }, 'application/json', 'Source redirected; update the base URL')
      if (!result.ok) return result
      try {
        return ok(await result.value.response.json())
      } catch {
        return ok(null)
      }
    },
    async getBytes(url, headers = {}, maxBytes = MAX_COVER_BYTES, followRedirect) {
      const result = await request('GET', undefined, url, headers, 'image/*', 'Redirects to covers are not allowed', timeoutMs, followRedirect)
      if (!result.ok) return result
      const body = await readLimited(result.value.response, result.value.host, maxBytes)
      if (!body.ok) return body
      return ok({ bytes: body.value, contentType: result.value.response.headers.get('content-type') })
    },
    async getText(url, headers = {}, maxBytes = MAX_PAGE_BYTES, timeout = timeoutMs) {
      const result = await request('GET', undefined, url, headers, 'text/html', 'The page redirected — open the book page itself', timeout)
      if (!result.ok) return result
      const body = await readLimited(result.value.response, result.value.host, maxBytes)
      if (!body.ok) return body
      return ok(new TextDecoder('utf-8').decode(body.value))
    },
  }
}
