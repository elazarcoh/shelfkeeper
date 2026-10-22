import type { EditionFormat } from './enums'

/** What volume sets need of an edition (spec: "Volume set"). */
export interface VolumeEditionLike {
  id: string
  format: EditionFormat
  language: string | null
  volume: number | null
  volumeCount: number | null
}

/** The volumes of one book in one format and language: derived, never stored. */
export interface VolumeSet<E extends VolumeEditionLike = VolumeEditionLike> {
  format: EditionFormat
  language: string | null
  /** max(volume_count of members, highest volume present) */
  size: number
  /** sorted by volume, then id */
  members: E[]
}

export function sameVolumeSet(a: Pick<VolumeEditionLike, 'format' | 'language'>, b: Pick<VolumeEditionLike, 'format' | 'language'>): boolean {
  return a.format === b.format && a.language === b.language
}

export function volumeSets<E extends VolumeEditionLike>(editions: readonly E[]): VolumeSet<E>[] {
  const sets: VolumeSet<E>[] = []
  for (const e of editions) {
    if (e.volume === null) continue
    let set = sets.find((s) => sameVolumeSet(s, e))
    if (set === undefined) {
      set = { format: e.format, language: e.language, size: 0, members: [] }
      sets.push(set)
    }
    set.members.push(e)
    set.size = Math.max(set.size, e.volume, e.volumeCount ?? 0)
  }
  for (const set of sets) set.members.sort((a, b) => (a.volume ?? 0) - (b.volume ?? 0) || a.id.localeCompare(b.id))
  return sets
}

export function missingVolumes(set: VolumeSet): number[] {
  const present = new Set(set.members.map((m) => m.volume))
  const missing: number[] = []
  for (let v = 1; v <= set.size; v++) if (!present.has(v)) missing.push(v)
  return missing
}

export function volumeLabel(volume: number | null, count: number | null): string | null {
  if (volume === null) return null
  return count === null ? `Vol ${volume}` : `Vol ${volume} of ${count}`
}

/** "vol 2", "vols 2, 3", and runs of three or more as ranges: "vols 1–3, 5". */
export function volumeList(nums: readonly number[]): string {
  if (nums.length === 1) return `vol ${nums[0]}`
  const parts: string[] = []
  for (let i = 0; i < nums.length; ) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === (nums[j] ?? 0) + 1) j++
    if (j - i >= 2) parts.push(`${nums[i]}–${nums[j]}`)
    else for (let k = i; k <= j; k++) parts.push(String(nums[k]))
    i = j + 1
  }
  return `vols ${parts.join(', ')}`
}

export function missingLabel(missing: readonly number[]): string | null {
  return missing.length === 0 ? null : `Missing: ${volumeList(missing)}`
}

/** Matching is lenient where a set is strict: an unknown language fits any. */
export function languagesMatch(a: string | null, b: string | null): boolean {
  return a === null || b === null || a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The set a volume of this format and language belongs to: the one with that language, ignoring case and spaces (null equals null),
 * else the only set of the format whose language matches leniently; otherwise none. Matching and filing both use it,
 * so a preview and the place the volume lands never disagree.
 */
export function setForVolume<S extends Pick<VolumeSet, 'format' | 'language'>>(sets: readonly S[], format: EditionFormat, language: string | null): S | undefined {
  const ofFormat = sets.filter((s) => s.format === format)
  const norm = (l: string | null) => l?.trim().toLowerCase() ?? null
  const exact = ofFormat.find((s) => norm(s.language) === norm(language))
  if (exact !== undefined) return exact
  const loose = ofFormat.filter((s) => languagesMatch(s.language, language))
  return loose.length === 1 ? loose[0] : undefined
}

/** A source item that is a volume the book's set doesn't have yet. */
export interface CandidateVolume {
  number: number
  /** the volume numbers already in the set */
  have: number[]
  size: number
}

export function newVolumeLabel(v: CandidateVolume, title: string | null): string {
  return `Volume ${v.number}${title === null ? '' : ` of ${title}`} (you have ${volumeList(v.have)})`
}

/** What a wish knows of the book's volumes: the set it would be filled from (#66). */
export interface WishVolumes {
  have: number[]
  size: number
  missing: number[]
  /** the set these describe */
  format: EditionFormat
  language: string | null
}

/** What is owned of the volume set that a wish's formats and language accept: the fullest such set. */
export function wishVolumes(wish: { formats: readonly EditionFormat[]; language: string | null }, editions: readonly VolumeEditionLike[]): WishVolumes | null {
  let best: { have: number[]; set: VolumeSet } | null = null
  for (const set of volumeSets(editions)) {
    if (wish.formats.length > 0 && !wish.formats.includes(set.format)) continue
    if (wish.language !== null && !languagesMatch(set.language, wish.language)) continue
    const have = [...new Set(set.members.map((m) => m.volume ?? 0))]
    if (best === null || have.length > best.have.length) best = { have, set }
  }
  return best === null ? null : { have: best.have, size: best.set.size, missing: missingVolumes(best.set), format: best.set.format, language: best.set.language }
}

export function wishVolumesLabel(v: WishVolumes): string {
  if (v.missing.length === 0) return `Have all ${v.size} volumes`
  return `Have ${volumeList(v.have)} of ${v.size} — missing ${volumeList(v.missing)}`
}
