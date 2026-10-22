import { missingLabel, missingVolumes, volumeSets } from '@mylib/domain'
import { formatLabel, languageName } from '@/lib/format'
import type { EditionDetail } from './edition-form-state'

export type EditionGroup =
  | { kind: 'single'; edition: EditionDetail }
  | { kind: 'set'; key: string; heading: string; missing: string | null; editions: EditionDetail[] }

/**
 * The book page's edition list: API order, except that each volume set is pulled together
 * (in volume order) at the position of its first member, under one heading
 * ("Hebrew · Physical · 2 volumes") with "Missing: vol 2" when a volume is absent.
 */
export function editionGroups(editions: readonly EditionDetail[]): EditionGroup[] {
  const sets = volumeSets(editions)
  const setOf = (e: EditionDetail) => sets.find((s) => s.members.includes(e))
  const groups: EditionGroup[] = []
  const placed = new Set<unknown>()
  for (const e of editions) {
    const set = setOf(e)
    if (set === undefined) {
      groups.push({ kind: 'single', edition: e })
      continue
    }
    if (placed.has(set)) continue
    placed.add(set)
    const parts = [set.language === null ? null : languageName(set.language), formatLabel[set.format]].filter((p) => p !== null)
    groups.push({
      kind: 'set',
      key: `${set.format}:${set.language ?? ''}`,
      heading: `${parts.join(' · ')} · ${set.size} ${set.size === 1 ? 'volume' : 'volumes'}`,
      missing: missingLabel(missingVolumes(set)),
      editions: set.members,
    })
  }
  return groups
}
