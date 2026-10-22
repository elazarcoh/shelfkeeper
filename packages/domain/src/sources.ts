import { z } from 'zod'
import { Asin, Isbn10, Isbn13 } from './catalog'
import { EditionFormat } from './enums'
import { normalizeLanguage } from './languages'
import { namedText } from './strings'
import { ItemVolume, volumeFromTitles } from './volume-marker'

export const sourceKinds = ['audiobookshelf', 'calibre', 'readarr', 'chaptarr', 'csv', 'manual', 'shelf'] as const
export const SourceKind = z.enum(sourceKinds)
export type SourceKind = z.infer<typeof SourceKind>

/** Sync schedule presets (UTC); null = no schedule, sync on demand only. */
export const sourceSchedules = ['hourly', 'daily', 'weekly'] as const
export const SourceSchedule = z.enum(sourceSchedules)
export type SourceSchedule = z.infer<typeof SourceSchedule>

const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((u) => u.replace(/\/+$/, ''))
const Secret = z.string().trim().min(1).max(4000)
const LibraryIds = z.array(z.string().trim().min(1).max(200)).max(50).nullable()

/** Kinds the worker syncs through a connector. CSV imports, shelf batches and manual entries are not synced (plan deviation 7). */
export const syncedSourceKinds = ['audiobookshelf', 'calibre', 'readarr', 'chaptarr'] as const
export type SyncedSourceKind = (typeof syncedSourceKinds)[number]
export const isSyncedKind = (kind: SourceKind): kind is SyncedSourceKind => (syncedSourceKinds as readonly string[]).includes(kind)

export const AudiobookshelfConfig = z.object({
  kind: z.literal('audiobookshelf'),
  baseUrl: BaseUrl,
  apiToken: Secret,
  /** null = every book library on the server */
  libraryIds: LibraryIds.default(null),
})
export type AudiobookshelfConfig = z.output<typeof AudiobookshelfConfig>

export const CalibreConfig = z.object({
  kind: z.literal('calibre'),
  baseUrl: BaseUrl,
  /** null when the content server doesn't require a login */
  username: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .default(null)
    .transform((s) => (s === '' ? null : s)),
  password: Secret.nullable().default(null),
  /** null = the server's default library */
  libraryId: z.string().trim().min(1).max(200).nullable().default(null),
  /** a custom column holding a word count, by its lookup name (e.g. "#words" from the Count Pages plugin) */
  wordCountColumn: z
    .string()
    .trim()
    .max(100)
    .regex(/^#[a-z0-9_]+$/, 'A custom column lookup name such as #words')
    .nullable()
    .default(null),
})
export type CalibreConfig = z.output<typeof CalibreConfig>

export const ReadarrConfig = z.object({ kind: z.literal('readarr'), baseUrl: BaseUrl, apiKey: Secret })
export type ReadarrConfig = z.output<typeof ReadarrConfig>
/** Chaptarr is a Readarr fork with a Readarr v1-compatible API (plan deviation 18). */
export const ChaptarrConfig = z.object({ kind: z.literal('chaptarr'), baseUrl: BaseUrl, apiKey: Secret })
export type ChaptarrConfig = z.output<typeof ChaptarrConfig>
export type ArrConfig = ReadarrConfig | ChaptarrConfig

/** One branch per synced connector kind. */
export const SourceConfig = z.discriminatedUnion('kind', [AudiobookshelfConfig, CalibreConfig, ReadarrConfig, ChaptarrConfig])
export type SourceConfig = z.output<typeof SourceConfig>

/** Fields stored encrypted at rest and never returned by the API. */
export const sourceSecretFields = {
  audiobookshelf: ['apiToken'],
  calibre: ['password'],
  readarr: ['apiKey'],
  chaptarr: ['apiKey'],
} as const satisfies Record<SyncedSourceKind, readonly string[]>

/** Like SourceConfig, but a secret may be omitted to keep the stored one (Calibre's password may also be cleared with null). */
export const SourceConfigUpdate = z.discriminatedUnion('kind', [
  AudiobookshelfConfig.extend({ apiToken: Secret.optional() }),
  CalibreConfig.extend({ password: Secret.nullable().optional() }),
  ReadarrConfig.extend({ apiKey: Secret.optional() }),
  ChaptarrConfig.extend({ apiKey: Secret.optional() }),
])
export type SourceConfigUpdate = z.output<typeof SourceConfigUpdate>

type SecretFieldOf<K extends SyncedSourceKind> = (typeof sourceSecretFields)[K][number]
type PublicOf<K extends SyncedSourceKind> = Omit<Extract<SourceConfig, { kind: K }>, SecretFieldOf<K>> & { hasSecret: boolean }
/** What the API shows an admin: the config minus its secrets, plus whether a secret is stored. */
export type PublicSourceConfig = { [K in SyncedSourceKind]: PublicOf<K> }[SyncedSourceKind]

export function publicSourceConfig(config: SourceConfigUpdate, hasSecret: boolean): PublicSourceConfig {
  const secrets: readonly string[] = sourceSecretFields[config.kind]
  const visible = Object.fromEntries(Object.entries(config).filter(([field]) => !secrets.includes(field)))
  return { ...visible, hasSecret } as PublicSourceConfig
}

export function toPublicConfig(config: SourceConfig): PublicSourceConfig {
  const values = Object.entries(config).filter(([field]) => (sourceSecretFields[config.kind] as readonly string[]).includes(field))
  return publicSourceConfig(config, values.some(([, v]) => typeof v === 'string' && v !== ''))
}

/** The stored config of a one-shot CSV import (plan deviation 7). Not a SourceConfig: nothing syncs it. */
export const CsvSourceConfig = z.object({
  kind: z.literal('csv'),
  ownerUserId: z.uuid(),
  fileName: z.string().trim().min(1).max(255),
  /** the client's id for this import (CsvImportInput.importId); absent on imports made before it existed */
  importId: z.uuid().optional(),
})
export type CsvSourceConfig = z.output<typeof CsvSourceConfig>

/**
 * `identifiers.others` keys that name the same book across different sources. Every other key
 * (audiobookshelfId, calibreId, readarrBookId, chaptarrBookId) is local to its source (plan deviation 6).
 * `libraryPath` is the book's folder relative to its library root: two apps reading the same files
 * (Audiobookshelf and Chaptarr on one folder, mounted at different places) report the same one (#104).
 */
export const globalIdKeys = ['goodreads', 'google', 'openlibrary', 'hardcover', 'simania', 'nli', 'libraryPath'] as const

/** The longest `identifiers.others` value; a longer path is left out rather than dropping the item's other ids. */
export const MAX_OTHER_ID_LENGTH = 1000

/**
 * A book's folder relative to its library root, as one canonical string: forward slashes, NFC, no
 * empty, "." or ".." segments. Null when nothing is left or it is too long to store.
 */
export function libraryPathOf(relative: string): string | null {
  const segments = relative.normalize('NFC').split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  const path = segments.join('/')
  return path.length > MAX_OTHER_ID_LENGTH ? null : path
}

export const CreateSourceInput = z.object({
  name: namedText(100),
  config: SourceConfig,
  schedule: SourceSchedule.nullable().default(null),
})
export type CreateSourceInput = z.output<typeof CreateSourceInput>

export const UpdateSourceInput = z
  .object({ name: namedText(100), config: SourceConfigUpdate, schedule: SourceSchedule.nullable() })
  .partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to update')
export type UpdateSourceInput = z.output<typeof UpdateSourceInput>

const Text = (max: number) => z.string().trim().min(1).max(max)
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .catch(null)
    .transform((s) => (s === '' ? null : s))

/**
 * What every connector yields (spec §5). Source data is messy: an invalid identifier
 * or series position becomes null instead of rejecting the whole item.
 */
export const ExternalItem = z.object({
  externalId: Text(300),
  format: EditionFormat,
  title: Text(500),
  subtitle: OptionalText(500),
  authors: z.array(Text(300)).max(50).default([]),
  narrators: z.array(Text(300)).max(50).default([]),
  translators: z.array(Text(300)).max(50).default([]),
  series: z
    .array(
      z
        .object({
          name: Text(300),
          position: z.number().min(0).max(100_000).nullable().catch(null),
          positionEnd: z.number().min(0).max(100_000).nullable().default(null).catch(null),
        })
        // an end that doesn't go up from the start is dropped, never the item (#122)
        .transform((s) => (s.positionEnd !== null && (s.position === null || s.positionEnd <= s.position) ? { ...s, positionEnd: null } : s)),
    )
    .max(10)
    .default([]),
  identifiers: z
    .object({
      isbn13: Isbn13.nullable().default(null).catch(null),
      isbn10: Isbn10.nullable().default(null).catch(null),
      asin: Asin.nullable().default(null).catch(null),
      others: z.record(z.string(), z.string().trim().min(1).max(MAX_OTHER_ID_LENGTH)).catch({}).default({}),
    })
    .default({ isbn13: null, isbn10: null, asin: null, others: {} }),
  publisher: OptionalText(300),
  publishedOn: z.iso.date().nullable().default(null).catch(null),
  pageCount: z.number().int().positive().max(100_000).nullable().default(null).catch(null),
  wordCount: z.number().int().positive().max(10_000_000).nullable().default(null).catch(null),
  durationSec: z.number().int().positive().max(1_000_000).nullable().default(null).catch(null),
  language: OptionalText(35).transform(normalizeLanguage),
  description: z.string().trim().max(20_000).nullable().default(null).catch(null),
  coverUrl: z.string().max(2000).nullable().default(null),
  // one over-long tag is dropped, never the whole item
  tags: z
    .array(z.string())
    .default([])
    .transform((tags) => tags.filter((t) => t.trim().length <= 100))
    .pipe(z.array(Text(100)).max(100)),
  wantedOnly: z.boolean().default(false),
  /** one volume of a book printed in several (#66); null for everything else, and for synced sources */
  volume: ItemVolume.nullable().default(null).catch(null),
  /** the title and subtitle as imported, set only when stripping a volume marker changed them: "not a volume" brings them back */
  importedTitle: z.object({ title: z.string(), subtitle: z.string().nullable() }).nullable().default(null).catch(null),
  /** the source's own record, kept on source_item for debugging; not part of the fingerprint */
  raw: z.unknown().optional(),
})
export type ExternalItem = z.output<typeof ExternalItem>

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    )
  }
  return value
}

/** Stable text of everything but `raw` and `coverUrl` — the sync engine hashes this to detect changes. */
export function externalItemFingerprint(item: ExternalItem): string {
  const content: Partial<ExternalItem> = { ...item }
  delete content.raw
  // the cover URL is built from the source's server address, so editing that address would reopen
  // every ignored item; covers aren't fetched yet (3a), so a cover change alone is no content change
  delete content.coverUrl
  // translators arrived after the first syncs: an empty list must not change the fingerprint of every stored item
  if (content.translators?.length === 0) delete content.translators
  // volumes arrived after the first syncs: a null volume must not change the fingerprint of every stored item
  if (content.volume === null) delete content.volume
  // likewise a null imported title
  if (content.importedTitle === null) delete content.importedTitle
  // ranges arrived after the first syncs (#122): a null end must not change the fingerprint of every stored item
  if (content.series) content.series = content.series.map(({ positionEnd, ...s }) => (positionEnd === null ? s : { ...s, positionEnd })) as ExternalItem['series']
  return JSON.stringify(canonical(content))
}

/** An item with the person's volume choice applied: undefined = no choice; null = "not a volume" (the imported title comes back). */
export function withVolumeOverride(item: ExternalItem, override: ItemVolume | null | undefined): ExternalItem {
  if (override === undefined) return item
  const t = item.importedTitle
  if (override !== null) {
    // a title brought back by an earlier "not a volume" is cleaned again
    if (t === null) return { ...item, volume: override }
    const cleaned = volumeFromTitles(t.title, t.subtitle)
    return { ...item, volume: override, title: cleaned.title, subtitle: cleaned.subtitle }
  }
  return { ...item, volume: null, title: t?.title ?? item.title, subtitle: t === null ? item.subtitle : t.subtitle }
}

export const connectorErrorKinds = ['unreachable', 'unauthorized', 'schema_mismatch', 'rate_limited', 'provider_error'] as const
export type ConnectorErrorKind = (typeof connectorErrorKinds)[number]
export interface ConnectorError {
  kind: ConnectorErrorKind
  message: string
}
export interface ItemError {
  externalId: string | null
  message: string
}

export interface SyncStats {
  seen: number
  created: number
  changed: number
  unchanged: number
  proposals: number
  removed: number
  restored: number
  /** linked to a copy another source already has, by the same files (#104); absent on runs before it */
  linked?: number
  invalid: number
  /** first 50 item problems, for the Jobs page */
  errors: ItemError[]
}

export const MAX_RECORDED_ITEM_ERRORS = 50

export const emptySyncStats = (): SyncStats => ({
  seen: 0,
  created: 0,
  changed: 0,
  unchanged: 0,
  proposals: 0,
  removed: 0,
  restored: 0,
  linked: 0,
  invalid: 0,
  errors: [],
})
