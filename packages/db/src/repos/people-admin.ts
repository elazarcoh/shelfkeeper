import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  DomainError,
  normalizeText,
  notFound,
  replacePersonInFilter,
  sortName,
  type AddNameInput,
  type EditionContributorRole,
  type ListPeopleInput,
  type MergePeopleInput,
  type SetNameLanguageInput,
  type SplitOffNameInput,
} from '@mylib/domain'
import type { Db } from '../client'
import { contributorNames, contributors, editionContributors, editions, sets, workContributors, works } from '../schema'
import { pruneOrphanPeople } from './people'
import { firstEditionLanguage } from './person-names'
import { refreshSearchDocument } from './search-index'
import { requireAdmin, type UserScope } from './scope'
import { shownTitleField } from './titles'

export interface PersonName {
  id: string
  name: string
  language: string | null
  primary: boolean
}
export interface PersonRow {
  id: string
  name: string
  curated: boolean
  /** primary first, then by name */
  names: PersonName[]
  /** books (works) crediting them in each role */
  authorOf: number
  translatorOf: number
  narratorOf: number
  illustratorOf: number
}
export interface PersonBook {
  workId: string
  title: string
  role: 'author' | EditionContributorRole
  nameId: string | null
  language: string | null
}
export interface PersonDetail extends PersonRow {
  /** distinct books in any role (the merge dialog's default primary) */
  bookCount: number
  /** at most PERSON_BOOKS_SHOWN, by title; language = the edition's, else the work's */
  books: PersonBook[]
}
export const PERSON_BOOKS_SHOWN = 200

// written out: drizzle drops the table qualifier in a single-table select, and the subqueries have an "id" of their own
const contributorId = sql`"contributor"."id"`
const authorOf = sql<number>`(select count(*)::int from ${workContributors} where ${workContributors.contributorId} = ${contributorId})`
const roleOf = (role: 'translator' | 'narrator' | 'illustrator') =>
  sql<number>`(select count(distinct ${editions.workId})::int from ${editionContributors} join ${editions} on ${editions.id} = ${editionContributors.editionId}
    where ${editionContributors.contributorId} = ${contributorId} and ${editionContributors.role} = ${role})`

async function peopleRows(db: Db, where: SQL | undefined, limit: number): Promise<PersonRow[]> {
  const people = await db
    .select({ id: contributors.id, name: contributors.name, normalizedName: contributors.normalizedName, curated: contributors.curated, authorOf, translatorOf: roleOf('translator'), narratorOf: roleOf('narrator'), illustratorOf: roleOf('illustrator') })
    .from(contributors)
    .where(where)
    .orderBy(asc(contributors.sortName), asc(contributors.id))
    .limit(limit)
  if (people.length === 0) return []
  const names = await db
    .select({ id: contributorNames.id, contributorId: contributorNames.contributorId, name: contributorNames.name, normalizedName: contributorNames.normalizedName, language: contributorNames.language })
    .from(contributorNames)
    .where(inArray(contributorNames.contributorId, people.map((p) => p.id)))
    .orderBy(asc(contributorNames.name))
  return people.map(({ normalizedName, ...p }) => ({
    ...p,
    names: names
      .filter((n) => n.contributorId === p.id)
      .map((n) => ({ id: n.id, name: n.name, language: n.language, primary: n.normalizedName === normalizedName }))
      .sort((a, b) => Number(b.primary) - Number(a.primary)),
  }))
}

/** Admin → Authors: everyone, searchable by any of their names (a growing limit, like the Inbox). */
export async function listPeople(db: Db, scope: UserScope, input: ListPeopleInput): Promise<{ people: PersonRow[]; more: boolean }> {
  requireAdmin(scope)
  const q = normalizeText(input.q)
  const where =
    q === ''
      ? undefined
      : sql`exists (select 1 from ${contributorNames} where ${contributorNames.contributorId} = ${contributorId} and strpos(${contributorNames.normalizedName}, ${q}) > 0)`
  const rows = await peopleRows(db, where, input.limit + 1)
  return { people: rows.slice(0, input.limit), more: rows.length > input.limit }
}

export async function getPerson(db: Db, scope: UserScope, personId: string): Promise<PersonDetail> {
  requireAdmin(scope)
  const [person] = await peopleRows(db, eq(contributors.id, personId), 1)
  if (!person) throw notFound('Person')
  const [asAuthor, asEditionPerson] = await Promise.all([
    db
      .select({ workId: works.id, title: shownTitleField(works.id, scope.languages, 'title'), nameId: workContributors.nameId, language: firstEditionLanguage(works.id) })
      .from(workContributors)
      .innerJoin(works, eq(works.id, workContributors.workId))
      .where(eq(workContributors.contributorId, personId)),
    db
      .select({ workId: works.id, title: shownTitleField(works.id, scope.languages, 'title'), role: editionContributors.role, nameId: editionContributors.nameId, language: sql<string | null>`coalesce(${editions.language}, ${firstEditionLanguage(works.id)})` })
      .from(editionContributors)
      .innerJoin(editions, eq(editions.id, editionContributors.editionId))
      .innerJoin(works, eq(works.id, editions.workId))
      .where(eq(editionContributors.contributorId, personId)),
  ])
  const books: PersonBook[] = [...asAuthor.map((b) => ({ ...b, role: 'author' as const })), ...asEditionPerson]
  books.sort((a, b) => a.title.localeCompare(b.title) || a.role.localeCompare(b.role))
  return { ...person, bookCount: new Set(books.map((b) => b.workId)).size, books: books.slice(0, PERSON_BOOKS_SHOWN) }
}

/** every work linked to these people, as author or through an edition (whose search rows a name change touches) */
export async function worksOfPeople(db: Db, contributorIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(contributorIds)]
  if (ids.length === 0) return []
  const [direct, viaEditions] = await Promise.all([
    db.selectDistinct({ id: workContributors.workId }).from(workContributors).where(inArray(workContributors.contributorId, ids)),
    db
      .selectDistinct({ id: editions.workId })
      .from(editionContributors)
      .innerJoin(editions, eq(editions.id, editionContributors.editionId))
      .where(inArray(editionContributors.contributorId, ids)),
  ])
  return [...new Set([...direct, ...viaEditions].map((r) => r.id))]
}

/** Locks these people (by id, so two merges or a merge and a prune cannot deadlock each other); returns those that exist. */
async function lockPeople(tx: Db, ids: readonly string[]) {
  return tx
    .select({ id: contributors.id, name: contributors.name, normalizedName: contributors.normalizedName })
    .from(contributors)
    .where(inArray(contributors.id, [...ids]))
    .orderBy(asc(contributors.id))
    .for('update')
}

/** a smart set whose filter holds this person's id */
const filtersBy = (personId: string) => sql`jsonb_path_exists(${sets.filter}, '$.** ? (@.contributorIds[*] == $id)', jsonb_build_object('id', ${personId}::text))`

/**
 * "Same person as…": one person keeps both people's books and names (the owner of the chosen primary name); the other
 * is deleted. A link keeps the name it credited; where both were on one book (or one edition in one role) the row with
 * the lower position stays. Locks both people first (FOR UPDATE), so a concurrent book write resolving a name of either one (FOR KEY SHARE in upsertContributors) waits for the merge and then resolves against the merged state.
 */
export async function mergePeople(db: Db, scope: UserScope, input: MergePeopleInput): Promise<{ personId: string }> {
  requireAdmin(scope)
  if (input.personId === input.otherId) throw new DomainError('INVALID', 'A person cannot be merged with themselves')
  return db.transaction(async (tx) => {
    const ids = [input.personId, input.otherId]
    if ((await lockPeople(tx, ids)).length !== 2) throw notFound('Person')
    const names = await tx
      .select({ id: contributorNames.id, contributorId: contributorNames.contributorId, name: contributorNames.name, normalizedName: contributorNames.normalizedName })
      .from(contributorNames)
      .where(inArray(contributorNames.contributorId, ids))
    const primary = names.find((n) => n.id === input.primaryNameId)
    if (!primary) throw new DomainError('INVALID', 'The primary name must be one of their names')
    if (input.languages.some((l) => !names.some((n) => n.id === l.nameId))) throw new DomainError('INVALID', 'A name is not one of theirs')
    const keepId = primary.contributorId
    const goneId = keepId === input.personId ? input.otherId : input.personId
    const affected = await worksOfPeople(tx, ids)

    // both on one book: drop the higher-positioned row (on a tie, the merged-away person's); table names are literal, like above
    await tx.execute(sql`delete from work_contributor as l using work_contributor as o
      where l.work_id = o.work_id
        and ((l.contributor_id = ${goneId} and o.contributor_id = ${keepId} and l.position >= o.position)
          or (l.contributor_id = ${keepId} and o.contributor_id = ${goneId} and l.position > o.position))`)
    await tx.execute(sql`delete from edition_contributor as l using edition_contributor as o
      where l.edition_id = o.edition_id and l.role = o.role
        and ((l.contributor_id = ${goneId} and o.contributor_id = ${keepId} and l.position >= o.position)
          or (l.contributor_id = ${keepId} and o.contributor_id = ${goneId} and l.position > o.position))`)
    // names before links (the name guard is checked at commit, so the order is for readers of this code, not the database)
    await tx.update(contributorNames).set({ contributorId: keepId }).where(eq(contributorNames.contributorId, goneId))
    await tx.update(workContributors).set({ contributorId: keepId }).where(eq(workContributors.contributorId, goneId))
    await tx.update(editionContributors).set({ contributorId: keepId }).where(eq(editionContributors.contributorId, goneId))
    for (const l of input.languages) await tx.update(contributorNames).set({ language: l.language }).where(eq(contributorNames.id, l.nameId))

    const smart = await tx
      .select({ id: sets.id, filter: sets.filter })
      .from(sets)
      .where(filtersBy(goneId))
    for (const s of smart) if (s.filter !== null) await tx.update(sets).set({ filter: replacePersonInFilter(s.filter, goneId, keepId) }).where(eq(sets.id, s.id))

    // the merged-away person goes first: the kept one may take its primary spelling (contributor.normalized_name is unique)
    await tx.delete(contributors).where(eq(contributors.id, goneId))
    await tx
      .update(contributors)
      .set({ name: primary.name, sortName: sortName(primary.name), normalizedName: primary.normalizedName, curated: true })
      .where(eq(contributors.id, keepId))
    for (const workId of affected) await refreshSearchDocument(tx, workId)
    return { personId: keepId }
  })
}

async function nameRow(tx: Db, nameId: string) {
  const [name] = await tx
    .select({ id: contributorNames.id, contributorId: contributorNames.contributorId, name: contributorNames.name, normalizedName: contributorNames.normalizedName })
    .from(contributorNames)
    .where(eq(contributorNames.id, nameId))
  if (!name) throw notFound('Name')
  return name
}

/** Locks the name's person and returns it with all its names (primary first, then by name). */
async function personOfName(tx: Db, nameId: string) {
  const name = await nameRow(tx, nameId)
  const [person] = await lockPeople(tx, [name.contributorId])
  if (!person) throw notFound('Person')
  // a split may have moved the name before we held the lock
  if ((await nameRow(tx, nameId)).contributorId !== name.contributorId) throw new DomainError('CONFLICT', 'That name just changed — try again')
  const names = (
    await tx
      .select({ id: contributorNames.id, name: contributorNames.name, normalizedName: contributorNames.normalizedName })
      .from(contributorNames)
      .where(eq(contributorNames.contributorId, person.id))
      .orderBy(asc(contributorNames.name))
  ).sort((a, b) => Number(b.normalizedName === person.normalizedName) - Number(a.normalizedName === person.normalizedName))
  return { name, person, names }
}

const asPrimary = (n: { name: string; normalizedName: string }) => ({ name: n.name, sortName: sortName(n.name), normalizedName: n.normalizedName })

async function refreshWorksOf(tx: Db, contributorIds: readonly string[]) {
  for (const workId of await worksOfPeople(tx, contributorIds)) await refreshSearchDocument(tx, workId)
}

/** "Split off this name": the name becomes its own person, with every book crediting it (spec: a full unmerge). */
export async function splitOffName(db: Db, scope: UserScope, input: SplitOffNameInput): Promise<{ personId: string }> {
  requireAdmin(scope)
  return db.transaction(async (tx) => {
    const { name, person, names } = await personOfName(tx, input.nameId)
    if (names.length < 2) throw new DomainError('INVALID', 'Their only name cannot be split off')
    const affected = await worksOfPeople(tx, [person.id])
    if (name.normalizedName === person.normalizedName) {
      const others = names.filter((n) => n.id !== name.id)
      const next = input.primaryNameId === null ? others[0] : others.find((n) => n.id === input.primaryNameId)
      if (!next) throw new DomainError('INVALID', 'The new primary name must be another of their names')
      // first: the new person takes this spelling as its normalized name, which is unique
      await tx.update(contributors).set(asPrimary(next)).where(eq(contributors.id, person.id))
    }
    await tx.update(contributors).set({ curated: true }).where(eq(contributors.id, person.id))
    const [created] = await tx.insert(contributors).values(asPrimary(name)).returning({ id: contributors.id })
    if (!created) throw new Error('Split failed')
    await tx.update(contributorNames).set({ contributorId: created.id }).where(eq(contributorNames.id, name.id))
    await tx.update(workContributors).set({ contributorId: created.id }).where(eq(workContributors.nameId, name.id))
    await tx.update(editionContributors).set({ contributorId: created.id }).where(eq(editionContributors.nameId, name.id))
    for (const workId of affected) await refreshSearchDocument(tx, workId)
    // spec "Orphans": a split-off name no book credits is an ordinary single-name orphan
    await pruneOrphanPeople(tx, [created.id])
    return { personId: created.id }
  })
}

export async function addPersonName(db: Db, scope: UserScope, input: AddNameInput): Promise<{ nameId: string }> {
  requireAdmin(scope)
  const normalized = normalizeText(input.name)
  if (normalized === '') throw new DomainError('INVALID', 'A name is required')
  return db.transaction(async (tx) => {
    const [person] = await lockPeople(tx, [input.personId])
    if (!person) throw notFound('Person')
    const [row] = await tx
      .insert(contributorNames)
      .values({ contributorId: person.id, name: input.name, normalizedName: normalized, language: input.language })
      .onConflictDoNothing({ target: contributorNames.normalizedName })
      .returning({ id: contributorNames.id })
    if (!row) {
      const [owner] = await tx
        .select({ id: contributors.id, name: contributors.name })
        .from(contributorNames)
        .innerJoin(contributors, eq(contributors.id, contributorNames.contributorId))
        .where(eq(contributorNames.normalizedName, normalized))
      if (owner?.id === person.id) throw new DomainError('CONFLICT', 'They already have that name')
      throw new DomainError('CONFLICT', `That name is ${owner?.name ?? 'someone else'}’s — use Same person as… instead`)
    }
    await tx.update(contributors).set({ curated: true }).where(eq(contributors.id, person.id))
    await refreshWorksOf(tx, [person.id])
    return { nameId: row.id }
  })
}

export async function setNameLanguage(db: Db, scope: UserScope, input: SetNameLanguageInput): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const { name, person } = await personOfName(tx, input.nameId)
    await tx.update(contributorNames).set({ language: input.language }).where(eq(contributorNames.id, name.id))
    await tx.update(contributors).set({ curated: true }).where(eq(contributors.id, person.id))
  })
}

export async function makeNamePrimary(db: Db, scope: UserScope, nameId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const { name, person } = await personOfName(tx, nameId)
    await tx.update(contributors).set({ ...asPrimary(name), curated: true }).where(eq(contributors.id, person.id))
  })
}

/** Books crediting the name keep the person and credit no name (display falls back by language); the spelling becomes free. */
export async function removePersonName(db: Db, scope: UserScope, nameId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const { name, person } = await personOfName(tx, nameId)
    if (name.normalizedName === person.normalizedName) throw new DomainError('INVALID', 'Make another name primary first')
    await tx.delete(contributorNames).where(eq(contributorNames.id, name.id))
    await tx.update(contributors).set({ curated: true }).where(eq(contributors.id, person.id))
    await refreshWorksOf(tx, [person.id])
  })
}

export async function deletePerson(db: Db, scope: UserScope, personId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const [person] = await lockPeople(tx, [personId])
    if (!person) throw notFound('Person')
    if ((await worksOfPeople(tx, [personId])).length > 0) throw new DomainError('CONFLICT', 'They are credited on books')
    const [set] = await tx.select({ id: sets.id }).from(sets).where(filtersBy(personId)).limit(1)
    if (set) throw new DomainError('CONFLICT', 'A smart set filters by them')
    await tx.delete(contributors).where(eq(contributors.id, personId))
  })
}
