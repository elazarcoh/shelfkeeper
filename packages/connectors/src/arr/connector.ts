import { z } from 'zod'
import { err, ok, type ArrConfig } from '@mylib/domain'
import { ConnectorFailure, fetchSameOrigin, type Connector } from '../connector'
import type { HttpClient } from '../http'
import { ArrAuthors, ArrBook, ArrBookFiles, ArrRootFolders, ArrStatus, type ArrBookFile } from './api'
import { toArrItems } from './map'

const headers = (config: ArrConfig) => ({ 'x-api-key': config.apiKey })

async function getOrFail<T>(http: HttpClient, url: string, config: ArrConfig, schema: z.ZodType<T>): Promise<T> {
  const response = await http.getJson(url, headers(config))
  if (!response.ok) throw new ConnectorFailure(response.error)
  const parsed = schema.safeParse(response.value)
  if (!parsed.success) throw new ConnectorFailure({ kind: 'schema_mismatch', message: `Unexpected response from ${new URL(url).pathname}` })
  return parsed.data
}

/** The root folders, or none when they can't be read: then items carry no library path, as before #104. */
async function rootFolders(http: HttpClient, config: ArrConfig): Promise<string[]> {
  const response = await http.getJson(`${config.baseUrl}/api/v1/rootfolder`, headers(config))
  if (!response.ok) return []
  const parsed = ArrRootFolders.safeParse(response.value)
  return parsed.success ? parsed.data.map((r) => r.path) : []
}

const idOf = (raw: unknown): number | null =>
  typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'number' ? raw.id : null

/** Readarr v1, and Chaptarr's Readarr-compatible API (plan deviation 18). */
export function createArrConnector<K extends ArrConfig['kind']>(kind: K, options: { batchSize?: number } = {}): Connector<Extract<ArrConfig, { kind: K }>> {
  const batchSize = options.batchSize ?? 50
  const connector: Connector<ArrConfig> = {
    kind,

    async test(config, http) {
      const response = await http.getJson(`${config.baseUrl}/api/v1/system/status`, headers(config))
      if (!response.ok) return err(response.error)
      const parsed = ArrStatus.safeParse(response.value)
      if (!parsed.success) return err({ kind: 'schema_mismatch', message: 'That server does not look like Readarr or Chaptarr' })
      return ok({ libraries: [`${parsed.data.appName} ${parsed.data.version}`] })
    },

    async *fetchItems(config, http) {
      const authors = new Map((await getOrFail(http, `${config.baseUrl}/api/v1/author`, config, ArrAuthors)).map((a) => [a.id, a.authorName]))
      const rawBooks = await getOrFail(http, `${config.baseUrl}/api/v1/book`, config, z.array(z.unknown()))
      const books: ArrBook[] = []
      for (const raw of rawBooks) {
        const parsed = ArrBook.safeParse(raw)
        if (parsed.success) books.push(parsed.data)
        else {
          const id = idOf(raw)
          yield err({ externalId: id === null ? null : `book:${id}`, message: 'Unexpected book shape' })
        }
      }

      const withFiles = books.filter((b) => (b.statistics?.bookFileCount ?? 0) > 0)
      const files = new Map<number, ArrBookFile[]>()
      for (let i = 0; i < withFiles.length; i += batchSize) {
        // /bookfile needs a filter; several bookId= params fetch one batch (never an unfiltered listing)
        const query = withFiles
          .slice(i, i + batchSize)
          .map((b) => `bookId=${b.id}`)
          .join('&')
        for (const file of await getOrFail(http, `${config.baseUrl}/api/v1/bookfile?${query}`, config, ArrBookFiles)) {
          files.set(file.bookId, [...(files.get(file.bookId) ?? []), file])
        }
      }

      const roots = withFiles.length === 0 ? [] : await rootFolders(http, config)
      for (const book of books) {
        const result = toArrItems(config, book, authors.get(book.authorId), files.get(book.id) ?? [], roots)
        if (!result.ok) {
          yield result
          continue
        }
        for (const item of result.value) yield ok(item)
      }
    },

    fetchCover(config, http, url) {
      return fetchSameOrigin(http, config.baseUrl, url, headers(config))
    },
  }
  // one implementation serves both kinds; K only narrows which config the caller may pass
  // (TypeScript cannot assign `kind: K` to `Extract<ArrConfig, { kind: K }>['kind']` for a generic K)
  return connector as Connector<Extract<ArrConfig, { kind: K }>>
}
