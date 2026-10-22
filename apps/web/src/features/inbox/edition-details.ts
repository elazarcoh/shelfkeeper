import { editionInputFromItem, type CsvOwnership, type ExternalItem } from '@mylib/domain'
import { editionFormFromInput, type EditionFormState } from '@/features/book/edition-form-state'

/** "This copy" as the dialog shows it; null hides it (a source copy, or a read-not-owned row keeps the import's holding). */
export type DetailsHolding = { ownership: 'owned' | 'borrowed'; note: string } | null

export function detailsHolding(ownership: CsvOwnership, borrowedFrom: string | null): DetailsHolding {
  if (ownership === 'read_not_owned') return null
  return { ownership, note: ownership === 'borrowed' ? (borrowedFrom ?? '') : '' }
}

/** The Add edition form for an Inbox item: what the item says, and how the import says it's held. */
export function detailsForm(item: ExternalItem, holding: DetailsHolding): EditionFormState {
  const form = editionFormFromInput(editionInputFromItem(item))
  return holding === null ? form : { ...form, ownership: holding.ownership, holdingNote: holding.note }
}
