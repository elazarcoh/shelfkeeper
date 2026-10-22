export const ACTIVITY_PREVIEW = 5

export function activityPreview<T>(items: readonly T[], showAll: boolean, limit = ACTIVITY_PREVIEW): { shown: T[]; hidden: number } {
  if (showAll || items.length <= limit) return { shown: [...items], hidden: 0 }
  return { shown: items.slice(0, limit), hidden: items.length - limit }
}
