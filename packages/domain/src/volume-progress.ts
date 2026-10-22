import { progressFraction, type EditionLength } from './progress'
import type { ProgressKind } from './enums'
import { volumeSets, type VolumeEditionLike } from './volumes'

/** One volume number's lengths in a set (#66): the copy with the length when two editions share a number. */
export interface VolumeLengths {
  volume: number
  pageCount: number | null
  durationSec: number | null
  wordCount: number | null
}

/** Where an edition sits in its volume set, with every present volume's lengths: serialisable, sent to the client. */
export interface VolumeContext {
  volume: number
  size: number
  volumes: VolumeLengths[]
}

export interface VolumeEditionLengths extends VolumeEditionLike {
  pageCount: number | null
  durationSec: number | null
  wordCount: number | null
}

const positive = (n: number | null): n is number => n !== null && n > 0
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** editionId → its set context; editions outside a set are absent (their fractions are today's rule). */
export function volumeContexts(editions: readonly VolumeEditionLengths[]): Map<string, VolumeContext> {
  const out = new Map<string, VolumeContext>()
  for (const set of volumeSets(editions)) {
    const byNumber = new Map<number, VolumeLengths>()
    for (const e of set.members) {
      const v = e.volume ?? 0
      const known = byNumber.get(v)
      // members are sorted by volume then id: the first copy stands unless a later one has a length it lacks
      const pick = (a: number | null, b: number | null) => (positive(a) ? a : b)
      byNumber.set(
        v,
        known === undefined
          ? { volume: v, pageCount: e.pageCount, durationSec: e.durationSec, wordCount: e.wordCount }
          : { volume: v, pageCount: pick(known.pageCount, e.pageCount), durationSec: pick(known.durationSec, e.durationSec), wordCount: pick(known.wordCount, e.wordCount) },
      )
    }
    const volumes = [...byNumber.values()].sort((a, b) => a.volume - b.volume)
    for (const e of set.members) out.set(e.id, { volume: e.volume ?? 0, size: set.size, volumes })
  }
  return out
}

type LengthKey = 'pageCount' | 'durationSec'

/** Every volume 1..size's length for this kind, with `own` standing in for the point's volume; null when any is unknown. */
function allLengths(ctx: VolumeContext, key: LengthKey, own: number | null): number[] | null {
  const lengths: number[] = []
  for (let v = 1; v <= ctx.size; v++) {
    const n = v === ctx.volume ? own : (ctx.volumes.find((x) => x.volume === v)?.[key] ?? null)
    if (!positive(n)) return null
    lengths.push(n)
  }
  return lengths
}

/** A point's share of the whole book (spec "Fractions and stats"); outside a set it is `progressFraction`. */
export function bookFraction(kind: ProgressKind, value: number, length: EditionLength, ctx: VolumeContext | null): number | null {
  const own = progressFraction(kind, value, length)
  if (ctx === null || ctx.size <= 1) return own
  if (kind !== 'percent') {
    const key: LengthKey = kind === 'page' ? 'pageCount' : 'durationSec'
    const lengths = allLengths(ctx, key, length[key])
    if (lengths !== null) {
      const before = lengths.slice(0, ctx.volume - 1).reduce((a, b) => a + b, 0)
      const total = lengths.reduce((a, b) => a + b, 0)
      return clamp01((before + Math.min(value, lengths[ctx.volume - 1] ?? 0)) / total)
    }
  }
  return own === null ? null : clamp01((ctx.volume - 1 + own) / ctx.size)
}

/** The book high-water mark (#7) over points that may sit in different volumes. */
export function bookHighest(points: readonly { kind: ProgressKind; value: number; length: EditionLength; ctx: VolumeContext | null }[]): number | null {
  let highest: number | null = null
  for (const p of points) {
    const f = bookFraction(p.kind, p.value, p.length, p.ctx)
    if (f !== null && (highest === null || f > highest)) highest = f
  }
  return highest
}

/** Stats' length source for a read of a set: the sum of every volume's value, else the own value × size. */
export function setAmountSource(
  ctx: VolumeContext | null,
  own: { pageCount: number | null; durationSec: number | null; wordCount: number | null },
): { pageCount: number | null; durationSec: number | null; wordCount: number | null } {
  if (ctx === null || ctx.size <= 1) return own
  const total = (key: keyof Omit<VolumeLengths, 'volume'>, mine: number | null): number | null => {
    let sum = 0
    for (let v = 1; v <= ctx.size; v++) {
      const n = v === ctx.volume ? mine : (ctx.volumes.find((x) => x.volume === v)?.[key] ?? null)
      if (!positive(n)) return positive(mine) ? mine * ctx.size : null
      sum += n
    }
    return sum
  }
  return { pageCount: total('pageCount', own.pageCount), durationSec: total('durationSec', own.durationSec), wordCount: total('wordCount', own.wordCount) }
}

export function nextVolumePresent(ctx: VolumeContext): boolean {
  return ctx.volumes.some((v) => v.volume === ctx.volume + 1)
}

/** The point is at (or past) the end of its own volume. */
export function atVolumeEnd(kind: ProgressKind, value: number, length: EditionLength): boolean {
  const f = progressFraction(kind, value, length)
  return f !== null && f >= 1 - 1e-9
}
