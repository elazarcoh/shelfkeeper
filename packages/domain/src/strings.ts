import { z } from 'zod'
import { normalizeText } from './text'

export const boundedText = (max: number) => z.string().trim().min(1, 'Required').max(max)

/** Text that must survive normalization (used for names that are de-duplicated by normalized form). */
export const namedText = (max: number) =>
  boundedText(max).refine((s) => normalizeText(s) !== '', 'Must contain a letter or digit')
