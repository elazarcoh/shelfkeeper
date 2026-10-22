import { z } from 'zod'
import { EditionInput } from './catalog'
import { ExternalItem } from './sources'

export const proposalKinds = ['source_match', 'new_work', 'metadata_update', 'create_wanted', 'queue_add', 'profile_update'] as const
export const ProposalKind = z.enum(proposalKinds)
export type ProposalKind = z.infer<typeof ProposalKind>

export const proposalStatuses = ['pending', 'accepted', 'rejected', 'superseded'] as const
export type ProposalStatus = (typeof proposalStatuses)[number]

export const proposalScopes = ['catalog', 'user'] as const
export type ProposalScope = (typeof proposalScopes)[number]

export const proposalCreators = ['sync', 'ai', 'chat', 'user', 'csv', 'photo'] as const
export type ProposalCreator = (typeof proposalCreators)[number]

/** Why a candidate was suggested: the same identifier, a formerly owned copy from this source, or title/author similarity. */
export const matchBases = ['identifier', 'restore', 'title_author'] as const
export type MatchBasis = (typeof matchBases)[number]

export const MatchCandidate = z.object({
  workId: z.uuid(),
  /** set when a specific existing copy matched (same identifier, or the formerly owned copy) */
  editionId: z.uuid().nullable(),
  score: z.number().min(0).max(1),
  basis: z.enum(matchBases),
  reasons: z.array(z.string()),
  /** the item is a volume this book's set doesn't have yet: add it as a new edition, never link an existing copy (#66) */
  volume: z.object({ number: z.number().int(), have: z.array(z.number().int()), size: z.number().int() }).nullable().default(null),
})
export type MatchCandidate = z.output<typeof MatchCandidate>

export const SourceMatchPayload = z.object({
  sourceId: z.uuid(),
  sourceItemId: z.uuid(),
  item: ExternalItem,
})
export type SourceMatchPayload = z.output<typeof SourceMatchPayload>

/** `edition`: the Add edition form as the person filled it in (#121); absent = the item as it came */
const linkNewEdition = z.object({ action: z.literal('link_new_edition'), workId: z.uuid(), edition: EditionInput.optional() })
const linkEdition = z.object({ action: z.literal('link_edition'), editionId: z.uuid() })
const createWork = z.object({ action: z.literal('create_work') })
const ignore = z.object({ action: z.literal('ignore') })
/** a wanted item IS this existing book: link it as the book's placeholder (no copy) */
const attachWanted = z.object({ action: z.literal('attach_wanted'), workId: z.uuid() })
/** create a wanted book — a work with no editions (spec §4) — for the item */
const createWanted = z.object({ action: z.literal('create_wanted') })

/** For a `source_match` proposal: the item is a copy. Linking it to a wanted book is `link_new_edition`. */
export const SourceMatchResolution = z.discriminatedUnion('action', [
  /** add the item as a new edition of an existing book (also how an item attaches to a wanted book) */
  linkNewEdition,
  /** the item IS this existing copy (same format) — link it, restoring it if formerly owned */
  linkEdition,
  createWork,
  ignore,
])
export type SourceMatchResolution = z.output<typeof SourceMatchResolution>

/** For a `create_wanted` proposal: the item is a book someone wants, not a copy. */
export const WantedResolution = z.discriminatedUnion('action', [attachWanted, createWanted, ignore])
export type WantedResolution = z.output<typeof WantedResolution>

/** What the Inbox accepts for either kind; the repository checks the action fits the proposal. */
export const InboxResolution = z.discriminatedUnion('action', [linkNewEdition, linkEdition, createWork, attachWanted, createWanted, ignore])
export type InboxResolution = z.output<typeof InboxResolution>
