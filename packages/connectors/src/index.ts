import type { SourceConfig, SyncedSourceKind } from '@mylib/domain'
import { createArrConnector } from './arr/connector'
import { audiobookshelf } from './audiobookshelf/connector'
import { calibre } from './calibre/connector'
import type { Connector } from './connector'

export { createArrConnector } from './arr/connector'
export { audiobookshelf } from './audiobookshelf/connector'
export { toExternalItems } from './audiobookshelf/map'
export { fetchAbsItem, patchAbsMedia } from './audiobookshelf/write'
export { calibre, createCalibreConnector } from './calibre/connector'
export * from './connector'
export * from './hardcover/client'
export { hardcoverPage } from './hardcover/page'
export * from './http'
export * from './open-library-work'

type ConnectorFor<K extends SyncedSourceKind> = Connector<Extract<SourceConfig, { kind: K }>>
const connectors: { [K in SyncedSourceKind]: ConnectorFor<K> } = {
  audiobookshelf,
  calibre,
  readarr: createArrConnector('readarr'),
  chaptarr: createArrConnector('chaptarr'),
}

/** Callers pass the config they looked the connector up by, so the kinds always agree. */
export function getConnector(kind: SyncedSourceKind): Connector {
  return connectors[kind]
}
