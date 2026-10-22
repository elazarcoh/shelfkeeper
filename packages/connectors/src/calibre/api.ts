import { z } from 'zod'

export const CalibreLibraryInfo = z.object({ library_map: z.record(z.string(), z.string()), default_library: z.string() })
export const CalibreSearch = z.object({ total_num: z.number().int().min(0), book_ids: z.array(z.number().int()) })

/** Only what we read; Calibre sends much more. */
export const CalibreBook = z
  .object({
    title: z.string().nullish(),
    authors: z.array(z.string()).nullish(),
    series: z.string().nullish(),
    series_index: z.number().nullish(),
    tags: z.array(z.string()).nullish(),
    identifiers: z.record(z.string(), z.string()).nullish(),
    publisher: z.string().nullish(),
    pubdate: z.string().nullish(),
    languages: z.array(z.string()).nullish(),
    comments: z.string().nullish(),
    formats: z.array(z.string()).nullish(),
    cover: z.string().nullish(),
    user_metadata: z.record(z.string(), z.looseObject({ '#value#': z.unknown().optional() })).nullish(),
  })
  .loose()
export type CalibreBook = z.output<typeof CalibreBook>

/** `/ajax/books`: id → book, or null when it vanished or a restriction hides it. */
export const CalibreBooks = z.record(z.string(), z.unknown().nullable())
