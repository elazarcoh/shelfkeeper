import type { z } from 'zod'

export type FieldErrors = Partial<Record<string, string>>

export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.')
    out[key] ??= issue.message
  }
  return out
}

/** Error for `prefix` itself or any nested path under it (e.g. "authors" or "authors.0"). */
export function firstError(errors: FieldErrors, prefix: string): string | undefined {
  if (errors[prefix] !== undefined) return errors[prefix]
  const key = Object.keys(errors).find((k) => k.startsWith(`${prefix}.`))
  return key === undefined ? undefined : errors[key]
}

/** Errors under `prefix.` with the prefix removed (e.g. "editions.0." → "isbn13"). */
export function scopedErrors(errors: FieldErrors, prefix: string): FieldErrors {
  const out: FieldErrors = {}
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = message
  }
  return out
}

export const parseLines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

export const parseCommaList = (s: string): string[] =>
  s
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '')

export const emptyToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim())

export const toNumberOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s))

// JSON writes NaN (unreadable number text) as null: keep it apart so typing "abc" over nothing is a change validation sees
const comparable = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v))

/** Keys of `after` whose values differ from `before` (compared structurally). */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
  const keys = Object.keys(after) as (keyof T)[]
  const changed = keys.filter((k) => comparable(before[k]) !== comparable(after[k]))
  return Object.fromEntries(changed.map((k) => [k, after[k]])) as Partial<T>
}
