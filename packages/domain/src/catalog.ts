import { z } from 'zod'
import { EditionFormat, EditionOwnership, WorkKind } from './enums'
import { cleanIsbn, isValidIsbn10, isValidIsbn13 } from './isbn'
import { normalizeLanguage } from './languages'
import { boundedText, namedText } from './strings'

export const PersonName = namedText(300)
export const TagName = namedText(100)
const SeriesNumber = z.number({ error: 'Use a number like 3 or a range like 1-2' }).min(0).max(100_000)
export const SeriesRef = z
  .object({
    name: namedText(300),
    position: SeriesNumber.nullable(),
    /** the last position of a range: one item holding several books of the series (#122) */
    positionEnd: SeriesNumber.nullable().default(null),
  })
  .refine((s) => s.positionEnd === null || (s.position !== null && s.positionEnd > s.position), {
    message: 'Use a number like 3 or a range like 1-2',
    path: ['position'],
  })
export type SeriesRef = z.output<typeof SeriesRef>

export const Isbn13 = z.string().transform(cleanIsbn).refine(isValidIsbn13, 'Invalid ISBN-13')
export const Isbn10 = z.string().transform(cleanIsbn).refine(isValidIsbn10, 'Invalid ISBN-10')
export const Asin = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'Invalid ASIN')
const LanguageCode = boundedText(35).transform(normalizeLanguage)

const workFields = {
  title: boundedText(500),
  subtitle: boundedText(500).nullable(),
  description: z.string().trim().max(20_000).nullable(),
  originalYear: z.number().int().min(-3000).max(3000).nullable(),
  authors: z.array(PersonName).min(1, 'Add at least one author').max(50),
  series: z.array(SeriesRef).max(10),
  tags: z.array(TagName).max(100),
  kind: WorkKind,
}
export type WorkField = keyof typeof workFields
export const workFieldNames = Object.keys(workFields) as WorkField[]

const editionFields = {
  format: EditionFormat,
  title: boundedText(500).nullable(),
  subtitle: boundedText(500).nullable(),
  isbn13: Isbn13.nullable(),
  isbn10: Isbn10.nullable(),
  asin: Asin.nullable(),
  publisher: boundedText(300).nullable(),
  publishedOn: z.iso.date().nullable(),
  pageCount: z.number().int().positive().max(100_000).nullable(),
  wordCount: z.number().int().positive().max(10_000_000).nullable(),
  durationSec: z.number().int().positive().max(1_000_000).nullable(),
  language: LanguageCode.nullable(),
  shelfLocation: boundedText(200).nullable(),
  volume: z.number().int().min(1).max(999).nullable(),
  volumeCount: z.number().int().min(1).max(999).nullable(),
  narrators: z.array(PersonName).max(50),
  translators: z.array(PersonName).max(50),
}
export type EditionField = keyof typeof editionFields
export const editionFieldNames = Object.keys(editionFields) as EditionField[]

const nonEmpty = (patch: Record<string, unknown>) => Object.values(patch).some((v) => v !== undefined)

/** `titleId`: edit this work_title row with `title`/`subtitle` (default: the primary, #145) */
export const WorkPatch = z.object({ ...workFields, titleId: z.uuid() }).partial().refine(nonEmpty, 'Nothing to update')
export type WorkPatch = z.output<typeof WorkPatch>

/** A title's language, e.g. `he` or `en`; blank means unknown. */
const TitleLanguage = z.string().trim().max(35).nullable().transform((l) => normalizeLanguage(l)?.toLowerCase() ?? null)

export const AddWorkTitleInput = z.object({ workId: z.uuid(), language: TitleLanguage, title: workFields.title, subtitle: workFields.subtitle.default(null) })
export type AddWorkTitleInput = z.output<typeof AddWorkTitleInput>
export const UpdateWorkTitleInput = z.object({ titleId: z.uuid(), title: workFields.title, subtitle: workFields.subtitle, language: TitleLanguage })
export type UpdateWorkTitleInput = z.output<typeof UpdateWorkTitleInput>
/** `newPrimaryId`: when the primary goes, the row that takes over (default: the remover's first language, else the first by id) */
export const RemoveWorkTitleInput = z.object({ titleId: z.uuid(), newPrimaryId: z.uuid().nullable().default(null) })
export type RemoveWorkTitleInput = z.output<typeof RemoveWorkTitleInput>
export const TitleIdInput = z.object({ titleId: z.uuid() })
export type TitleIdInput = z.output<typeof TitleIdInput>

export const EditionPatch = z.object(editionFields).partial().refine(nonEmpty, 'Nothing to update')
export type EditionPatch = z.output<typeof EditionPatch>

export const EditionInput = z.object({
  format: editionFields.format,
  title: editionFields.title.default(null),
  subtitle: editionFields.subtitle.default(null),
  isbn13: editionFields.isbn13.default(null),
  isbn10: editionFields.isbn10.default(null),
  asin: editionFields.asin.default(null),
  publisher: editionFields.publisher.default(null),
  publishedOn: editionFields.publishedOn.default(null),
  pageCount: editionFields.pageCount.default(null),
  wordCount: editionFields.wordCount.default(null),
  durationSec: editionFields.durationSec.default(null),
  language: editionFields.language.default(null),
  shelfLocation: editionFields.shelfLocation.default(null),
  volume: editionFields.volume.default(null),
  volumeCount: editionFields.volumeCount.default(null),
  narrators: editionFields.narrators.default([]),
  translators: editionFields.translators.default([]),
  /** initial holding — later changes go through HoldingChange actions */
  ownership: EditionOwnership.default('owned'),
  holdingOn: z.iso.date().nullable().default(null),
  holdingNote: boundedText(200).nullable().default(null),
}).superRefine((e, ctx) => {
  if (e.volumeCount !== null && e.volume === null) {
    ctx.addIssue({ code: 'custom', path: ['volumeCount'], message: 'Set the volume number first' })
  } else if (e.volume !== null && e.volumeCount !== null && e.volume > e.volumeCount) {
    ctx.addIssue({ code: 'custom', path: ['volume'], message: "Volume can't be higher than the number of volumes" })
  }
})
export type EditionInput = z.output<typeof EditionInput>

export const CreateWorkInput = z.object({
  title: workFields.title,
  subtitle: workFields.subtitle.default(null),
  description: workFields.description.default(null),
  originalYear: workFields.originalYear.default(null),
  authors: workFields.authors,
  series: workFields.series.default([]),
  tags: workFields.tags.default([]),
  // left out, the work is a book and kind stays unlocked for the automatic rules (#133)
  kind: workFields.kind.optional(),
  editions: z.array(EditionInput).min(1).max(20),
})
export type CreateWorkInput = z.output<typeof CreateWorkInput>
