import { z } from 'zod'
import { FieldOrigin } from './enums'

export const ProvenanceEntry = z.object({
  origin: FieldOrigin,
  sourceId: z.uuid().optional(),
  aiRunId: z.uuid().optional(),
  at: z.iso.datetime(),
  locked: z.boolean(),
})
export type ProvenanceEntry = z.output<typeof ProvenanceEntry>

export const Provenance = z.record(z.string(), ProvenanceEntry)
export type Provenance = z.output<typeof Provenance>

/** A direct human edit: the field becomes manual and locked against future sync/AI overwrites. */
export function markManual(provenance: Provenance, fields: readonly string[], at: Date): Provenance {
  const next: Provenance = { ...provenance }
  for (const field of fields) next[field] = { origin: 'manual', at: at.toISOString(), locked: true }
  return next
}

export function isLocked(provenance: Provenance, field: string): boolean {
  return provenance[field]?.locked === true
}

/** Fields set from a source: provenance records which source, and stays unlocked so later syncs may update it. */
export function markSource(provenance: Provenance, fields: readonly string[], sourceId: string, at: Date): Provenance {
  const next: Provenance = { ...provenance }
  for (const field of fields) next[field] = { origin: 'source', sourceId, at: at.toISOString(), locked: false }
  return next
}
