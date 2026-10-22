import type { FieldErrors } from '@/lib/form'

/** Work fields that stay visible on phones: Title and Authors (required). Edition errors never belong to the work panel. */
export const isOptionalWorkKey = (key: string): boolean => !/^(title|authors|editions)(\.|$)/.test(key)

/** Edition fields that stay visible on phones: Format (required) and the holding fields next to "This copy". */
export const isOptionalEditionKey = (key: string): boolean => !/^(format|ownership|holdingOn|holdingNote)(\.|$)/.test(key)

export const hasOptionalError = (errors: FieldErrors, isOptionalKey: (key: string) => boolean): boolean => Object.keys(errors).some(isOptionalKey)

/** The optional panel hides on phones (below sm) while collapsible and closed; from sm up it always shows. */
export const optionalPanelHiddenClass = (collapsible: boolean, open: boolean): string => (collapsible && !open ? 'max-sm:hidden' : '')

export const PHONE_MATCH_LIMIT = 2

/** On phones only the first PHONE_MATCH_LIMIT catalog matches show until "Show N more". */
export const hiddenOnPhone = (index: number, expanded: boolean): boolean => !expanded && index >= PHONE_MATCH_LIMIT

export const moreMatchesCount = (total: number, expanded: boolean): number => (expanded ? 0 : Math.max(0, total - PHONE_MATCH_LIMIT))
