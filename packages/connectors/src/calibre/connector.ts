import type { z } from 'zod'
import { err, ok, type CalibreConfig, type ConnectorError } from '@mylib/domain'
import { ConnectorFailure, fetchSameOrigin, type Connector } from '../connector'
import type { HttpClient } from '../http'
import { CalibreBooks, CalibreLibraryInfo, CalibreSearch } from './api'
import { toCalibreItem } from './map'

const BASIC_ONLY = 'Calibre rejected the login. The content server must use basic authentication (start it with calibre-server --auth-mode=basic).'

/** A username without a password would silently go out as no login at all: refuse it instead. */
const HALF_LOGIN: ConnectorError = { kind: 'unauthorized', message: 'Calibre needs both a username and a password' }
const halfLogin = (config: CalibreConfig): boolean => config.username !== null && config.password === null

function auth(config: CalibreConfig): Record<string, string> {
  if (config.username === null || config.password === null) return {}
  return { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}` }
}

async function getOrFail<T>(http: HttpClient, url: string, config: CalibreConfig, schema: z.ZodType<T>): Promise<T> {
  const response = await http.getJson(url, auth(config))
  if (!response.ok) throw new ConnectorFailure(response.error.kind === 'unauthorized' ? { kind: 'unauthorized', message: BASIC_ONLY } : response.error)
  const parsed = schema.safeParse(response.value)
  if (!parsed.success) throw new ConnectorFailure({ kind: 'schema_mismatch', message: `Unexpected response from ${new URL(url).pathname}` })
  return parsed.data
}

/** The configured library by its id, or by the display name the person sees in Calibre (`library_map` is id → name). */
function libraryOf(info: z.output<typeof CalibreLibraryInfo>, config: CalibreConfig): { id: string; name: string } | null {
  const wanted = config.libraryId ?? info.default_library
  const name = info.library_map[wanted]
  if (name !== undefined) return { id: wanted, name }
  const byName = Object.entries(info.library_map).find(([, n]) => n === wanted)
  return byName === undefined ? null : { id: byName[0], name: byName[1] }
}

export function createCalibreConnector(options: { pageSize?: number } = {}): Connector<CalibreConfig> {
  const pageSize = options.pageSize ?? 100
  return {
    kind: 'calibre',

    async test(config, http) {
      if (halfLogin(config)) return err(HALF_LOGIN)
      const response = await http.getJson(`${config.baseUrl}/ajax/library-info`, auth(config))
      if (!response.ok) return err(response.error.kind === 'unauthorized' ? { kind: 'unauthorized', message: BASIC_ONLY } : response.error)
      const parsed = CalibreLibraryInfo.safeParse(response.value)
      if (!parsed.success) return err({ kind: 'schema_mismatch', message: 'That server does not look like a Calibre content server' })
      const library = libraryOf(parsed.data, config)
      if (library === null) return err({ kind: 'provider_error', message: `No library "${config.libraryId ?? ''}" on this server` })
      return ok({ libraries: [library.name] })
    },

    async *fetchItems(config, http) {
      if (halfLogin(config)) throw new ConnectorFailure(HALF_LOGIN)
      const library = libraryOf(await getOrFail(http, `${config.baseUrl}/ajax/library-info`, config, CalibreLibraryInfo), config)
      if (library === null) throw new ConnectorFailure({ kind: 'provider_error', message: `No library "${config.libraryId ?? ''}" on this server` })
      const lib = encodeURIComponent(library.id)
      for (let offset = 0; ; offset += pageSize) {
        const page = await getOrFail(http, `${config.baseUrl}/ajax/search/${lib}?query=&num=${pageSize}&offset=${offset}&sort=id&sort_order=asc`, config, CalibreSearch)
        if (page.book_ids.length === 0) break
        const books = await getOrFail(http, `${config.baseUrl}/ajax/books/${lib}?ids=${page.book_ids.join(',')}`, config, CalibreBooks)
        for (const id of page.book_ids) {
          const raw = books[String(id)]
          // deleted between search and read, or hidden by a restriction: it is simply not there
          if (raw === undefined || raw === null) continue
          const mapped = toCalibreItem(config, String(id), raw)
          if (!mapped.ok) yield mapped
          else if (mapped.value !== null) yield ok(mapped.value)
        }
        if (offset + page.book_ids.length >= page.total_num) break
      }
    },

    fetchCover(config, http, url) {
      if (halfLogin(config)) return Promise.resolve(err(HALF_LOGIN))
      return fetchSameOrigin(http, config.baseUrl, url, auth(config))
    },
  }
}

export const calibre = createCalibreConnector()
