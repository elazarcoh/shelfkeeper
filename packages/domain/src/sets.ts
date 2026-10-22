import { z } from 'zod'
import { SetScope } from './enums'
import { SmartFilter } from './filter'
import { boundedText } from './strings'

export const SetName = boundedText(100)

export const CreateSetInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), scope: SetScope, name: SetName }),
  z.object({ kind: z.literal('smart'), scope: SetScope, name: SetName, filter: SmartFilter }),
])
export type CreateSetInput = z.output<typeof CreateSetInput>

export const UpdateSetInput = z
  .object({ name: SetName.optional(), filter: SmartFilter.optional(), defaultForNewUsers: z.boolean().optional() })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to update')
export type UpdateSetInput = z.output<typeof UpdateSetInput>
