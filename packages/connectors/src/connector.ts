import { err, ok, type ConnectorError, type ExternalItem, type ItemError, type Result, type SourceConfig, MAX_COVER_BYTES } from '@mylib/domain'
import type { HttpClient } from './http'

/** A fatal problem while fetching: the whole run fails and nothing is marked removed. */
export class ConnectorFailure extends Error {
  override readonly name = 'ConnectorFailure'
  constructor(readonly error: ConnectorError) {
    super(error.message)
  }
}

export interface Connector<C extends SourceConfig = SourceConfig> {
  kind: C['kind']
  /** "Test connection": reach the source and list what would be synced. */
  test(config: C, http: HttpClient): Promise<Result<{ libraries: string[] }, ConnectorError>>
  /** Every item the source has, complete. Per-item problems are yielded as errors; fatal ones throw ConnectorFailure. */
  fetchItems(config: C, http: HttpClient): AsyncIterable<Result<ExternalItem, ItemError>>
  /** One cover image. Only URLs on the source's own server are fetched (plan deviation 13). */
  fetchCover(config: C, http: HttpClient, url: string): Promise<Result<Uint8Array, ConnectorError>>
}

/** Resolves `url` against the source and fetches it only if it stays on the source's origin — credentials never go elsewhere. */
export async function fetchSameOrigin(
  http: HttpClient,
  baseUrl: string,
  url: string,
  headers: Record<string, string>,
): Promise<Result<Uint8Array, ConnectorError>> {
  let target: URL
  try {
    target = new URL(url, `${baseUrl}/`)
  } catch {
    return err({ kind: 'provider_error', message: 'Invalid cover URL' })
  }
  if (target.origin !== new URL(baseUrl).origin) return err({ kind: 'provider_error', message: 'The cover is not on this source\'s server' })
  const response = await http.getBytes(target.toString(), headers, MAX_COVER_BYTES)
  return response.ok ? ok(response.value.bytes) : err(response.error)
}
