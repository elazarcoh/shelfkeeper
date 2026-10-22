import type { CurrentProgress } from '@mylib/domain'

/**
 * The progress row under Home's "Currently reading" covers: only once progress has loaded AND the reader has at least
 * one current point. Otherwise undefined, so the shelf renders exactly as it did before progress existed (spec §1: no
 * bar and no reserved row). A reader's very first point costs one small shift; later loads reserve the row.
 */
export function shelfProgress(current: readonly CurrentProgress[] | undefined): ReadonlyMap<string, number> | undefined {
  if (current === undefined || current.length === 0) return undefined
  return new Map(current.map((c) => [c.workId, c.fraction]))
}
