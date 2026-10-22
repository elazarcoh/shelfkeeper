import { ok, type AudiobookshelfConfig, type Result } from '@mylib/domain'
import type { HttpClient, HttpError } from '../http'

const auth = (config: AudiobookshelfConfig) => ({ authorization: `Bearer ${config.apiToken}` })
const itemUrl = (config: AudiobookshelfConfig, absItemId: string) => `${config.baseUrl}/api/items/${encodeURIComponent(absItemId)}`

/** One item as Audiobookshelf holds it right now (`?expanded=1`), unparsed. */
export function fetchAbsItem(config: AudiobookshelfConfig, http: HttpClient, absItemId: string): Promise<Result<unknown, HttpError>> {
  return http.getJson(`${itemUrl(config, absItemId)}?expanded=1`, auth(config))
}

/** Updates an item's book metadata (`PATCH /api/items/:id/media`, body `{ metadata }`). Needs a key that can edit books. */
export async function patchAbsMedia(
  config: AudiobookshelfConfig,
  http: HttpClient,
  absItemId: string,
  metadata: Record<string, unknown>,
): Promise<Result<void, HttpError>> {
  const result = await http.patchJson(`${itemUrl(config, absItemId)}/media`, { metadata }, auth(config))
  return result.ok ? ok(undefined) : result
}
