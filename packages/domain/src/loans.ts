import { z } from 'zod'
import { boundedText } from './strings'

export const LoanInput = z
  .object({
    editionId: z.uuid(),
    borrowerUserId: z.uuid().nullable().default(null),
    borrowerName: boundedText(120).nullable().default(null),
    lentOn: z.iso.date(),
    dueOn: z.iso.date().nullable().default(null),
  })
  .refine((v) => (v.borrowerUserId === null) !== (v.borrowerName === null), {
    message: 'Choose a household member or enter a name, not both',
    path: ['borrowerName'],
  })
export type LoanInput = z.output<typeof LoanInput>
