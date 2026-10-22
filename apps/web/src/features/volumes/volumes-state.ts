import type { GroupReview, MergeVolumesInput, VolumeGroup } from '@mylib/domain'

export const dismissedKey = (userId: string): string => `mylib:volumes:dismissed:${userId}`

/** The group keys this person marked "Not volumes"; unreadable or missing storage reads as none. */
export function loadDismissed(storage: Pick<Storage, 'getItem'> | null, userId: string): Set<string> {
  try {
    const raw = storage?.getItem(dismissedKey(userId)) ?? null
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function saveDismissed(storage: Pick<Storage, 'setItem'> | null, userId: string, keys: ReadonlySet<string>): void {
  try {
    storage?.setItem(dismissedKey(userId), JSON.stringify([...keys]))
  } catch {
    // no storage: the dismissal lasts until the page is reloaded
  }
}

/** The groups to review: the app's, then the AI's, without dismissed ones or ones with a book that was merged away. */
export function shownGroups(app: readonly VolumeGroup[], ai: readonly VolumeGroup[], dismissed: ReadonlySet<string>, catalogIds: ReadonlySet<string>): VolumeGroup[] {
  return [...app, ...ai].filter((g) => !dismissed.has(g.key) && g.members.every((m) => catalogIds.has(m.workId)))
}

export function toMergeInput(review: GroupReview): MergeVolumesInput {
  return { survivorId: review.survivorId, title: review.title.trim(), members: review.members, volumeCount: review.volumeCount }
}
