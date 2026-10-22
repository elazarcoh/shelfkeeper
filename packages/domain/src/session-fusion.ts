import type { DatePrecision, SessionMode, SessionOutcome } from './enums'
import { isDatedPrecision, resolveDateRange } from './sessions'

/** One reading session of a merged book, as far as deciding whether per-volume sessions are one read. */
export interface FusionSession {
  id: string
  userId: string
  mode: SessionMode
  volume: number | null
  editionId: string | null
  outcome: SessionOutcome
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
  fractionCompleted: number | null
  /** the book this session belonged to before the merge (the survivor's own sessions: the survivor) */
  origin: string
  /** `${format}|${language}` of the session's edition; null when it has none */
  setKey: string | null
}

export interface FusedRead {
  userId: string
  /** the chain's first session */
  keepId: string
  /** the rest, in chain (volume) order */
  mergeIds: string[]
  volumes: number[]
  editionId: string | null
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
  outcome: SessionOutcome
  fractionCompleted: number | null
}

type Volumed = FusionSession & { volume: number }

const startFrom = (s: FusionSession): string => resolveDateRange(s.startedOn, s.startedPrecision).from
const finishRange = (s: FusionSession) => resolveDateRange(s.finishedOn ?? s.startedOn, s.finishedPrecision ?? s.startedPrecision)

function compareSessions(a: Volumed, b: Volumed): number {
  if (a.volume !== b.volume) return a.volume - b.volume
  const fa = startFrom(a)
  const fb = startFrom(b)
  if (fa !== fb) return fa < fb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** True when `next` could have started after `last` finished (or when either date says nothing about when). */
function canFollow(last: FusionSession, next: FusionSession): boolean {
  if (last.finishedOn === null || last.finishedPrecision === null) return true
  if (!isDatedPrecision(last.finishedPrecision) || !isDatedPrecision(next.startedPrecision)) return true
  return resolveDateRange(next.startedOn, next.startedPrecision).to >= resolveDateRange(last.finishedOn, last.finishedPrecision).from
}

/** Two sessions can be one read only within one volume set (same format and language) when both say which. */
const sameSet = (a: FusionSession, b: FusionSession): boolean => a.setKey === null || b.setKey === null || a.setKey === b.setKey

/** Past reads: every session finished, one per volume, from different books, in one set, at least two volumes: one read, whatever the dates say. */
function isPastReadPartition(sessions: readonly Volumed[]): boolean {
  if (sessions.some((s) => s.outcome !== 'finished')) return false
  const volumes = new Set(sessions.map((s) => s.volume))
  if (volumes.size < 2 || volumes.size !== sessions.length) return false
  if (new Set(sessions.map((s) => s.origin)).size !== sessions.length) return false
  return new Set(sessions.flatMap((s) => (s.setKey === null ? [] : [s.setKey]))).size <= 1
}

/**
 * Tie-break between rival predecessors: among the unused finished sessions of `last`'s own volume that `next` can
 * follow, `last` must be the one that finished latest (ties: the later in sort order). Otherwise an older read (say a
 * 2024 volume 1) would grab the volume 2 that belongs to a newer read of volume 1 sorted after it.
 */
function isBestPredecessor(last: Volumed, next: Volumed, unused: readonly Volumed[]): boolean {
  const finish = (s: Volumed) => finishRange(s).from
  return unused
    .filter((s) => s.volume === last.volume && s.outcome === 'finished' && canFollow(s, next))
    .every((r) => finish(r) < finish(last) || (finish(r) === finish(last) && compareSessions(r, last) <= 0))
}

function buildChains(sorted: readonly Volumed[]): Volumed[][] {
  const used = new Set<string>()
  const chains: Volumed[][] = []
  for (const head of sorted) {
    if (used.has(head.id)) continue
    used.add(head.id)
    const chain = [head]
    for (;;) {
      const last = chain[chain.length - 1] ?? head
      if (last.outcome !== 'finished') break
      const unused = sorted.filter((s) => !used.has(s.id))
      const later = unused.filter((s) => s.volume > last.volume)
      if (later.length === 0) break
      const nextVolume = Math.min(...later.map((s) => s.volume))
      const next = later.find(
        (s) =>
          s.volume === nextVolume &&
          chain.every((c) => c.origin !== s.origin && sameSet(c, s)) &&
          canFollow(last, s) &&
          isBestPredecessor(last, s, unused),
      )
      if (!next) break
      used.add(next.id)
      chain.push(next)
    }
    chains.push(chain)
  }
  return chains
}

function fuse(first: Volumed, chain: readonly Volumed[], volumeCount: number | null): FusedRead {
  const last = chain[chain.length - 1] ?? first
  const datedStarts = chain.filter((s) => isDatedPrecision(s.startedPrecision))
  const start = datedStarts.reduce<Volumed>((best, s) => (startFrom(s) < startFrom(best) ? s : best), datedStarts[0] ?? first)
  let finishedOn: string | null = null
  let finishedPrecision: DatePrecision | null = null
  if (last.outcome !== 'in_progress') {
    const datedFinishes = chain.filter((s) => s.finishedOn !== null && s.finishedPrecision !== null && isDatedPrecision(s.finishedPrecision))
    const end = datedFinishes.reduce<Volumed>((best, s) => (finishRange(s).to > finishRange(best).to ? s : best), datedFinishes[0] ?? last)
    finishedOn = end.finishedOn
    finishedPrecision = end.finishedPrecision
  }
  let fractionCompleted: number | null = null
  if (last.outcome === 'finished') fractionCompleted = 1
  else if (last.outcome === 'abandoned') {
    const size = Math.max(volumeCount ?? 0, ...chain.map((s) => s.volume))
    fractionCompleted = Math.min(1, (last.volume - 1 + (last.fractionCompleted ?? 0.5)) / size)
  }
  return {
    userId: first.userId,
    keepId: first.id,
    mergeIds: chain.slice(1).map((s) => s.id),
    volumes: chain.map((s) => s.volume),
    editionId: [...chain].reverse().find((s) => s.editionId !== null)?.editionId ?? null,
    startedOn: start.startedOn,
    startedPrecision: start.startedPrecision,
    finishedOn,
    finishedPrecision,
    outcome: last.outcome,
    fractionCompleted,
  }
}

/**
 * After per-volume books are merged into one, decides which of a person's sessions are the same read (one per
 * volume, in sequence) and what the fused session looks like. Sessions with no volume never fuse.
 */
export function planSessionFusion(sessions: readonly FusionSession[], volumeCount: number | null): FusedRead[] {
  const partitions = new Map<string, Volumed[]>()
  for (const s of sessions) {
    if (s.volume === null) continue
    const key = `${s.userId}\u0000${s.mode}`
    const list = partitions.get(key) ?? []
    list.push(s as Volumed)
    partitions.set(key, list)
  }
  const reads: FusedRead[] = []
  for (const list of partitions.values()) {
    const sorted = [...list].sort(compareSessions)
    const chains = isPastReadPartition(sorted) ? [sorted] : buildChains(sorted)
    for (const chain of chains) if (chain.length >= 2) reads.push(fuse(chain[0] as Volumed, chain, volumeCount))
  }
  return reads.sort((a, b) => (a.userId !== b.userId ? (a.userId < b.userId ? -1 : 1) : a.keepId < b.keepId ? -1 : a.keepId > b.keepId ? 1 : 0))
}
