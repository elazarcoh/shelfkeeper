import { z } from 'zod'
import { UserRole } from './enums'
import { normalizeLanguage } from './languages'
import { boundedText } from './strings'

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,32}$/, 'Use 2–32 letters, digits, dots, dashes or underscores')
export const Password = z.string().min(8, 'At least 8 characters').max(200)
export const Pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits')
export const DisplayName = boundedText(100)

/** The languages a person prefers for titles and names, in order: normalized codes, no blanks or repeats. */
export function normalizeTitleLanguages(raw: readonly string[]): string[] {
  const codes = raw.map(normalizeLanguage).filter((c): c is string => c !== null)
  return [...new Set(codes)]
}
export const TitleLanguages = z
  .array(z.string())
  .min(1)
  .max(5)
  .transform(normalizeTitleLanguages)
  .refine((l) => l.length > 0, 'Pick at least one language')

export const SetupInput = z.object({ username: Username, displayName: DisplayName, password: Password })
export const LoginInput = z.object({ username: Username, password: z.string().min(1).max(200) })
export const PinLoginInput = z.object({ username: Username, pin: z.string().min(1).max(8) })
export const CreateUserInput = z.object({ username: Username, displayName: DisplayName, password: Password, role: UserRole })

export const UpdateUserInput = z
  .object({ displayName: DisplayName.optional(), role: UserRole.optional(), shareActivity: z.boolean().optional(), titleLanguages: TitleLanguages.optional() })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to update')
export type UserPatch = z.output<typeof UpdateUserInput>
