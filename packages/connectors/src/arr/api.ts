import { z } from 'zod'

export const ArrStatus = z.looseObject({ appName: z.string(), version: z.string() })
export const ArrAuthors = z.array(z.looseObject({ id: z.number().int(), authorName: z.string() }))

const ArrImage = z.looseObject({ coverType: z.string(), url: z.string().nullish() })
const ArrEdition = z.looseObject({
  isbn13: z.string().nullish(),
  asin: z.string().nullish(),
  publisher: z.string().nullish(),
  pageCount: z.number().nullish(),
  language: z.string().nullish(),
  isEbook: z.boolean().nullish(),
  monitored: z.boolean().nullish(),
})

export const ArrBook = z.looseObject({
  id: z.number().int(),
  title: z.string(),
  authorId: z.number().int(),
  seriesTitle: z.string().nullish(),
  overview: z.string().nullish(),
  releaseDate: z.string().nullish(),
  pageCount: z.number().nullish(),
  genres: z.array(z.string()).nullish(),
  monitored: z.boolean(),
  images: z.array(ArrImage).nullish(),
  editions: z.array(ArrEdition).nullish(),
  statistics: z.looseObject({ bookFileCount: z.number().int() }).nullish(),
})
export type ArrBook = z.output<typeof ArrBook>

export const ArrBookFiles = z.array(
  z.looseObject({
    id: z.number().int(),
    bookId: z.number().int(),
    path: z.string(),
    quality: z.looseObject({ quality: z.looseObject({ name: z.string() }) }).nullish(),
  }),
)
export type ArrBookFile = z.output<typeof ArrBookFiles>[number]

/** Where the app keeps its books; a file's path below one is its path within that library (#104). */
export const ArrRootFolders = z.array(z.looseObject({ path: z.string() }))
