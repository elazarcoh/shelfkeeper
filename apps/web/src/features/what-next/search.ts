import { whatNextFormats, whatNextMoods, type WhatNextFormat, type WhatNextMood } from '@mylib/domain'

export interface NextSearch {
  mood?: WhatNextMood
  format?: WhatNextFormat
}

const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined => values.find((x) => x === v)

/** `?mood&format`: an unknown value is dropped, so the page falls back to the preselected mood and the saved format. */
export function parseNextSearch(raw: Record<string, unknown>): NextSearch {
  const mood = oneOf(whatNextMoods, raw['mood'])
  const format = oneOf(whatNextFormats, raw['format'])
  return { ...(mood !== undefined ? { mood } : {}), ...(format !== undefined ? { format } : {}) }
}
