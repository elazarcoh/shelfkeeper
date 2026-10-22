import { and, eq, inArray, notExists, sql } from 'drizzle-orm'
import { DomainError, normalizeLanguage, normalizeText, scriptLanguage, sortName } from '@mylib/domain'
import type { Db } from '../client'
import { contributorNames, contributors, series, seriesNames, tags } from '../schema'

interface Named {
  name: string
  normalized: string
}

function uniqueByNormalized(names: readonly string[]): Named[] {
  const seen = new Map<string, Named>()
  for (const raw of names) {
    const name = raw.trim()
    const normalized = normalizeText(name)
    if (normalized !== '' && !seen.has(normalized)) seen.set(normalized, { name, normalized })
  }
  return [...seen.values()]
}

function align(names: readonly string[], rows: { id: string; normalizedName: string }[]): string[] {
  const byNormalized = new Map(rows.map((r) => [r.normalizedName, r.id]))
  return names.map((name) => {
    const id = byNormalized.get(normalizeText(name))
    if (id === undefined) throw new Error(`Lookup failed for "${name}"`)
    return id
  })
}

export const uniqueIds = (ids: readonly string[]): string[] => [...new Set(ids)]

export interface PersonRef {
  contributorId: string
  nameId: string
}

const nameRefs = { id: contributorNames.id, contributorId: contributorNames.contributorId, normalizedName: contributorNames.normalizedName }

/**
 * The names already in use with their people, each person locked FOR KEY SHARE: an admin merge, split, name removal or
 * delete holds FOR UPDATE on the person, so this waits for it. Once it commits, Postgres rechecks the locked person but
 * not the name row it had already read, so the names are read again by a plain select (a new statement sees committed
 * state): a name that moved to someone not yet locked gets that person locked and is read again, and a name that is gone
 * is left out, so it reads as unknown and falls through to the insert path below. A person we hold cannot lose or gain a
 * name, since every admin edit locks them first.
 */
async function lockKnown(db: Db, normalized: string[]) {
  if (normalized.length === 0) return []
  const held = new Set(
    (
      await db
        .select({ contributorId: contributorNames.contributorId })
        .from(contributorNames)
        .innerJoin(contributors, eq(contributors.id, contributorNames.contributorId))
        .where(inArray(contributorNames.normalizedName, normalized))
        .orderBy(contributors.id)
        .for('key share', { of: contributors })
    ).map((r) => r.contributorId),
  )
  for (let round = 0; round < 5; round++) {
    const rows = await db.select(nameRefs).from(contributorNames).where(inArray(contributorNames.normalizedName, normalized))
    const unheld = uniqueIds(rows.map((r) => r.contributorId).filter((id) => !held.has(id))).sort()
    if (unheld.length === 0) return rows
    const locked = await db.select({ id: contributors.id }).from(contributors).where(inArray(contributors.id, unheld)).orderBy(contributors.id).for('key share')
    for (const p of locked) held.add(p.id)
  }
  throw new DomainError('CONFLICT', 'That name just changed — try again')
}

/** The person each name belongs to (by any of their names), creating a person for a name nobody has; aligned with `names`. */
export async function upsertContributors(db: Db, names: readonly string[], rawLanguage: string | null = null): Promise<PersonRef[]> {
  const language = normalizeLanguage(rawLanguage)
  const unique = uniqueByNormalized(names)
  if (unique.length === 0) return []
  const known = await lockKnown(db, unique.map((u) => u.normalized))
  const refs = new Map(known.map((k) => [k.normalizedName, { contributorId: k.contributorId, nameId: k.id }]))
  const missing = unique.filter((u) => !refs.has(u.normalized))
  if (missing.length > 0) {
    // a new spelling is a new person; `on conflict` keeps a concurrent first use to one person and one name
    const people = await db
      .insert(contributors)
      .values(missing.map((u) => ({ name: u.name, sortName: sortName(u.name), normalizedName: u.normalized })))
      .onConflictDoUpdate({ target: contributors.normalizedName, set: { normalizedName: sql`excluded.normalized_name` } })
      .returning({ id: contributors.id, normalizedName: contributors.normalizedName })
    const personOf = new Map(people.map((p) => [p.normalizedName, p.id]))
    const rows = await db
      .insert(contributorNames)
      .values(
        missing.map((u) => {
          const contributorId = personOf.get(u.normalized)
          if (contributorId === undefined) throw new Error(`Lookup failed for "${u.name}"`)
          return { contributorId, name: u.name, normalizedName: u.normalized, language }
        }),
      )
      .onConflictDoUpdate({ target: contributorNames.normalizedName, set: { normalizedName: sql`excluded.normalized_name` } })
      .returning({ id: contributorNames.id, contributorId: contributorNames.contributorId, normalizedName: contributorNames.normalizedName })
    // a name that moved (or appeared) meanwhile resolves to its current owner; the person made for it is then left without names
    const strays = people.filter((p) => !rows.some((r) => r.contributorId === p.id)).map((p) => p.id)
    if (strays.length > 0)
      await db.delete(contributors).where(and(inArray(contributors.id, strays), notExists(db.select({ one: sql`1` }).from(contributorNames).where(eq(contributorNames.contributorId, contributors.id)))))
    for (const r of await lockKnown(db, rows.map((r) => r.normalizedName))) refs.set(r.normalizedName, { contributorId: r.contributorId, nameId: r.id })
    for (const r of rows) if (!refs.has(r.normalizedName)) refs.set(r.normalizedName, { contributorId: r.contributorId, nameId: r.id })
  }
  return names.flatMap((name) => {
    const normalized = normalizeText(name)
    if (normalized === '') return []
    const ref = refs.get(normalized)
    if (ref === undefined) throw new Error(`Lookup failed for "${name}"`)
    return [ref]
  })
}

/** One ref per person, the first spelling winning (an author list may name the same person twice). */
export function uniquePeople(refs: readonly PersonRef[]): PersonRef[] {
  const seen = new Set<string>()
  const out: PersonRef[] = []
  for (const r of refs) {
    if (seen.has(r.contributorId)) continue
    seen.add(r.contributorId)
    out.push(r)
  }
  return out
}

/** A series is found by any of its names (series_name); an unknown spelling makes a new series with that name. */
export async function upsertSeries(db: Db, names: readonly string[]): Promise<string[]> {
  const unique = uniqueByNormalized(names)
  if (unique.length === 0) return []
  const known = await db
    .select({ seriesId: seriesNames.seriesId, normalizedName: seriesNames.normalizedName })
    .from(seriesNames)
    .where(inArray(seriesNames.normalizedName, unique.map((u) => u.normalized)))
  const owner = new Map(known.map((r) => [r.normalizedName, r.seriesId]))
  const fresh = unique.filter((u) => !owner.has(u.normalized))
  if (fresh.length > 0) {
    const made = await db
      .insert(series)
      .values(fresh.map((u) => ({ name: u.name, normalizedName: u.normalized })))
      .onConflictDoUpdate({ target: series.normalizedName, set: { normalizedName: sql`excluded.normalized_name` } })
      .returning({ id: series.id, normalizedName: series.normalizedName })
    const madeOf = new Map(made.map((r) => [r.normalizedName, r.id]))
    await db
      .insert(seriesNames)
      .values(
        fresh.map((u) => {
          const seriesId = madeOf.get(u.normalized)
          if (seriesId === undefined) throw new Error(`Lookup failed for "${u.name}"`)
          return { seriesId, name: u.name, normalizedName: u.normalized, language: scriptLanguage(u.name) }
        }),
      )
      .onConflictDoNothing({ target: seriesNames.normalizedName })
    // the name's current owner wins (a concurrent first use may have claimed it for another series)
    for (const r of await db
      .select({ seriesId: seriesNames.seriesId, normalizedName: seriesNames.normalizedName })
      .from(seriesNames)
      .where(inArray(seriesNames.normalizedName, fresh.map((u) => u.normalized)))) owner.set(r.normalizedName, r.seriesId)
    const strays = made.filter((r) => owner.get(r.normalizedName) !== r.id).map((r) => r.id)
    if (strays.length > 0)
      await db.delete(series).where(and(inArray(series.id, strays), notExists(db.select({ one: sql`1` }).from(seriesNames).where(eq(seriesNames.seriesId, series.id)))))
  }
  return names.map((name) => {
    const id = owner.get(normalizeText(name))
    if (id === undefined) throw new Error(`Lookup failed for "${name}"`)
    return id
  })
}

export async function upsertTags(db: Db, names: readonly string[]): Promise<string[]> {
  const unique = uniqueByNormalized(names)
  if (unique.length === 0) return []
  const rows = await db
    .insert(tags)
    .values(unique.map((u) => ({ name: u.name, normalizedName: u.normalized })))
    .onConflictDoUpdate({ target: tags.normalizedName, set: { normalizedName: sql`excluded.normalized_name` } })
    .returning({ id: tags.id, normalizedName: tags.normalizedName })
  return align(names, rows)
}
