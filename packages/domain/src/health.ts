import { z } from 'zod'
import type { EditionFormat } from './enums'

/** Admin → Health checks, in the order the page shows them (spec 2026-10-18-data-health). */
export const healthChecks = ['no_cover', 'no_isbn', 'no_author', 'no_length', 'duplicates', 'empty_series', 'series_gaps', 'long_loans', 'kind_suggestions', 'abs_out_of_sync'] as const
/** The checks one SQL query answers; abs_out_of_sync is computed in TS (#115). */
export const sqlHealthChecks = healthChecks.filter((c) => c !== 'abs_out_of_sync')
export const HealthCheck = z.enum(healthChecks)
export type HealthCheck = z.infer<typeof HealthCheck>
export const SqlHealthCheck = z.enum(sqlHealthChecks)
export type SqlHealthCheck = z.infer<typeof SqlHealthCheck>
export type HealthCounts = Record<HealthCheck, number>

export interface HealthWork {
  id: string
  title: string
}
export interface HealthSeries {
  id: string
  name: string
}

/** One problem row; `key` is what an ignore row stores for it. */
export type HealthItem =
  | { check: 'no_cover' | 'no_isbn' | 'no_author'; key: string; work: HealthWork }
  | { check: 'no_length'; key: string; work: HealthWork; edition: { id: string; format: EditionFormat; volume: number | null } }
  | { check: 'duplicates'; key: string; works: [HealthWork, HealthWork] }
  | { check: 'empty_series'; key: string; series: HealthSeries }
  | { check: 'series_gaps'; key: string; series: HealthSeries; missing: number[]; unnumbered: number }
  | { check: 'kind_suggestions'; key: string; work: HealthWork; suggested: 'fanfiction' | 'web_serial' }
  | { check: 'long_loans'; key: string; work: HealthWork; loan: { id: string; borrower: string; lentOn: string; dueOn: string | null } }

/** A duplicate pair's key: both work ids, smaller first, so a pair has one key whichever way it is found. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export const HealthCountsInput = z.object({ today: z.iso.date() })
export const HealthListInput = z.object({
  check: SqlHealthCheck,
  today: z.iso.date(),
  limit: z.number().int().min(1).max(2000).default(50),
  /** true lists only the ignored rows */
  showIgnored: z.boolean().default(false),
})
export type HealthListInput = z.output<typeof HealthListInput>
export const HealthIgnoreInput = z.object({ check: HealthCheck, subjectKey: z.string().min(1).max(80) })
export type HealthIgnoreInput = z.output<typeof HealthIgnoreInput>
export const HealthSeriesInput = z.object({ seriesId: z.uuid() })
