import type { z } from 'zod'
import { err, ok, type AudiobookshelfConfig } from '@mylib/domain'
import { ConnectorFailure, fetchSameOrigin, type Connector } from '../connector'
import type { HttpClient } from '../http'
import { AbsItemsPage, AbsLibraries, type AbsLibrary } from './api'
import { toExternalItems } from './map'

const PAGE_SIZE = 100
const DETAIL_CONCURRENCY = 4

const auth = (config: AudiobookshelfConfig) => ({ authorization: `Bearer ${config.apiToken}` })

function bookLibraries(libraries: readonly AbsLibrary[], config: AudiobookshelfConfig): AbsLibrary[] {
  return libraries.filter((l) => l.mediaType === 'book' && (config.libraryIds === null || config.libraryIds.includes(l.id)))
}

async function getOrFail<T>(http: HttpClient, url: string, config: AudiobookshelfConfig, schema: z.ZodType<T>): Promise<T> {
  const response = await http.getJson(url, auth(config))
  if (!response.ok) throw new ConnectorFailure(response.error)
  const parsed = schema.safeParse(response.value)
  if (!parsed.success) throw new ConnectorFailure({ kind: 'schema_mismatch', message: `Unexpected response from ${new URL(url).pathname}` })
  return parsed.data
}

export const audiobookshelf: Connector<AudiobookshelfConfig> = {
  kind: 'audiobookshelf',

  async test(config, http) {
    const response = await http.getJson(`${config.baseUrl}/api/libraries`, auth(config))
    if (!response.ok) return err(response.error)
    const parsed = AbsLibraries.safeParse(response.value)
    if (!parsed.success) return err({ kind: 'schema_mismatch', message: 'That server does not look like Audiobookshelf' })
    const books = bookLibraries(parsed.data.libraries, config)
    if (books.length === 0) return err({ kind: 'provider_error', message: 'No book libraries found — check the library IDs' })
    return ok({ libraries: books.map((l) => l.name) })
  },

  async *fetchItems(config, http) {
    const { libraries } = await getOrFail(http, `${config.baseUrl}/api/libraries`, config, AbsLibraries)
    for (const library of bookLibraries(libraries, config)) {
      for (let page = 0; ; page++) {
        const url = `${config.baseUrl}/api/libraries/${encodeURIComponent(library.id)}/items?limit=${PAGE_SIZE}&page=${page}&minified=1`
        const data = await getOrFail(http, url, config, AbsItemsPage)
        const ids = data.results.filter((r) => r.isMissing !== true).map((r) => r.id)
        for (let i = 0; i < ids.length; i += DETAIL_CONCURRENCY) {
          const batch = ids.slice(i, i + DETAIL_CONCURRENCY)
          const details = await Promise.all(
            batch.map((id) => http.getJson(`${config.baseUrl}/api/items/${encodeURIComponent(id)}?expanded=1`, auth(config))),
          )
          for (const [index, detail] of details.entries()) {
            if (!detail.ok) {
              // deleted between listing and reading: it is simply gone
              if (detail.error.status === 404) continue
              // the token or the server went away: nothing after this can be trusted, fail the run
              if (detail.error.kind === 'unauthorized' || detail.error.kind === 'unreachable') throw new ConnectorFailure(detail.error)
              // one book the server couldn't serve: record it and keep going (spec §8). The sync engine
              // counts it as still present, so its copy is not marked gone (plan deviations 12–13).
              yield err({ externalId: batch[index] ?? null, message: detail.error.message })
              continue
            }
            const mapped = toExternalItems(config.baseUrl, detail.value)
            if (!mapped.ok) {
              yield mapped
              continue
            }
            for (const item of mapped.value) yield ok(item)
          }
        }
        if (data.results.length === 0 || (page + 1) * PAGE_SIZE >= data.total) break
      }
    }
  },

  fetchCover(config, http, url) {
    return fetchSameOrigin(http, config.baseUrl, url, auth(config))
  },
}
