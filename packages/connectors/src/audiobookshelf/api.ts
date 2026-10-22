import { z } from 'zod'

// Only the fields we read. Zod strips everything else, so new server fields never break a sync.
export const AbsLibraries = z.object({
  libraries: z.array(z.object({ id: z.string(), name: z.string(), mediaType: z.string() })),
})
export type AbsLibrary = z.output<typeof AbsLibraries>['libraries'][number]

export const AbsItemsPage = z.object({
  results: z.array(z.object({ id: z.string(), isMissing: z.boolean().optional() })),
  total: z.number().int().nonnegative(),
})

const nullableText = z.string().nullable().optional()

export const AbsItem = z.object({
  id: z.string(),
  mediaType: z.string(),
  isMissing: z.boolean().default(false),
  isInvalid: z.boolean().default(false),
  /** the book's folder (or, with isFile, its single file) relative to its library folder */
  relPath: z.string().nullable().optional(),
  isFile: z.boolean().default(false),
  media: z.object({
    metadata: z.object({
      title: nullableText,
      subtitle: nullableText,
      authors: z.array(z.object({ name: z.string() })).default([]),
      narrators: z.array(z.string()).default([]),
      series: z.array(z.object({ name: z.string(), sequence: nullableText })).default([]),
      genres: z.array(z.string()).default([]),
      publishedDate: nullableText,
      publisher: nullableText,
      description: nullableText,
      descriptionPlain: nullableText,
      isbn: nullableText,
      asin: nullableText,
      language: nullableText,
    }),
    tags: z.array(z.string()).default([]),
    duration: z.number().nullable().optional(),
    numAudioFiles: z.number().optional(),
    audioFiles: z.array(z.unknown()).default([]),
    ebookFile: z.object({ ebookFormat: nullableText }).nullable().optional(),
  }),
})
export type AbsItem = z.output<typeof AbsItem>
