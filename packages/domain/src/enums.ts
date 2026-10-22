import { z } from 'zod'

export const editionFormats = ['physical', 'ebook', 'audiobook'] as const
export const EditionFormat = z.enum(editionFormats)
export type EditionFormat = z.infer<typeof EditionFormat>

/** Whether a copy is ours or borrowed; independent of whether we still have it (see holdings.ts). */
export const editionOwnerships = ['owned', 'borrowed'] as const
export const EditionOwnership = z.enum(editionOwnerships)
export type EditionOwnership = z.infer<typeof EditionOwnership>

export const holdingEventTypes = ['acquired', 'removed', 'restored', 'borrowed', 'returned'] as const
export const HoldingEventType = z.enum(holdingEventTypes)
export type HoldingEventType = z.infer<typeof HoldingEventType>

export const holdingOrigins = ['manual', 'sync'] as const
export const HoldingOrigin = z.enum(holdingOrigins)
export type HoldingOrigin = z.infer<typeof HoldingOrigin>

/** Derived per work from its editions, in precedence order (see deriveAvailability). */
export const availabilities = ['owned', 'borrowed', 'formerly_owned', 'not_owned', 'wanted'] as const
export const Availability = z.enum(availabilities)
export type Availability = z.infer<typeof Availability>

export const userRoles = ['admin', 'member'] as const
export const UserRole = z.enum(userRoles)
export type UserRole = z.infer<typeof UserRole>

export const readingStatuses = ['none', 'want_to_read', 'reading', 'read', 'abandoned'] as const
export const ReadingStatus = z.enum(readingStatuses)
export type ReadingStatus = z.infer<typeof ReadingStatus>

export const editionContributorRoles = ['narrator', 'translator', 'illustrator'] as const
export const EditionContributorRole = z.enum(editionContributorRoles)
export type EditionContributorRole = z.infer<typeof EditionContributorRole>

export const fieldOrigins = ['source', 'ai', 'manual', 'csv'] as const
export const FieldOrigin = z.enum(fieldOrigins)
export type FieldOrigin = z.infer<typeof FieldOrigin>

export const setScopes = ['global', 'personal'] as const
export const SetScope = z.enum(setScopes)
export type SetScope = z.infer<typeof SetScope>

export const setKinds = ['manual', 'smart'] as const
export const SetKind = z.enum(setKinds)
export type SetKind = z.infer<typeof SetKind>

export const sessionModes = ['read', 'listen'] as const
export const SessionMode = z.enum(sessionModes)
export type SessionMode = z.infer<typeof SessionMode>

export const sessionOutcomes = ['in_progress', 'finished', 'abandoned'] as const
export const SessionOutcome = z.enum(sessionOutcomes)
export type SessionOutcome = z.infer<typeof SessionOutcome>

export const datePrecisions = ['day', 'month', 'year', 'unknown'] as const
export const DatePrecision = z.enum(datePrecisions)
export type DatePrecision = z.infer<typeof DatePrecision>

/** What a reading-progress point measures: a page, a position in seconds, or (ebooks, no edition) a percentage. */
export const progressKinds = ['page', 'seconds', 'percent'] as const
export const ProgressKind = z.enum(progressKinds)
export type ProgressKind = z.infer<typeof ProgressKind>

export const goalMetrics = ['books', 'hours', 'words', 'pages'] as const
export const GoalMetric = z.enum(goalMetrics)
export type GoalMetric = z.infer<typeof GoalMetric>

/** What sort of work this is; fanfiction and web serials read differently from published books. */
export const workKinds = ['book', 'fanfiction', 'web_serial'] as const
export const WorkKind = z.enum(workKinds)
export type WorkKind = z.infer<typeof WorkKind>
