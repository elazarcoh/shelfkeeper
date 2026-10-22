import {
  DomainError,
  markManual,
  normalizeLanguage,
  notFound,
  scriptLanguage,
  sortTitle,
  type AddWorkTitleInput,
  type RemoveWorkTitleInput,
  type TitleIdInput,
  type UpdateWorkTitleInput,
} from '@mylib/domain'
import { and, eq, ne, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { Db } from '../client'
import { alias } from 'drizzle-orm/pg-core'
import { editions, workTitles, works } from '../schema'
import { languageArray, outer } from './person-names'
import { refreshSearchDocument } from './search-index'
import type { UserScope } from './scope'

const sameLanguage = (language: string | null) => sql`${workTitles.language} is not distinct from ${language}::text`

/**
 * The one way a book's title changes (#145): writes work.title/subtitle/sort_title and keeps the `primary` work_title
 * row equal to them. Omitting `language` keeps the primary's language (a new primary guesses it from the script).
 * Another row already holding the language the primary moves onto is deleted: its title is replaced, never duplicated.
 * Call it after insert(works) and in place of every direct title write; it runs inside the caller's transaction.
 */
export async function setPrimaryTitle(
  tx: Db,
  workId: string,
  t: { title: string; subtitle: string | null; language?: string | null },
): Promise<void> {
  const sort = sortTitle(t.title)
  await tx.update(works).set({ title: t.title, subtitle: t.subtitle, sortTitle: sort }).where(eq(works.id, workId))
  const [primary] = await tx.select({ id: workTitles.id, language: workTitles.language }).from(workTitles).where(and(eq(workTitles.workId, workId), eq(workTitles.primary, true)))
  const language = primary
    ? t.language === undefined
      ? primary.language
      : normalizeLanguage(t.language)
    : (normalizeLanguage(t.language) ?? scriptLanguage(t.title))
  // the language is unique per book: whoever else holds it gives way
  await tx.delete(workTitles).where(and(eq(workTitles.workId, workId), sameLanguage(language), ...(primary ? [ne(workTitles.id, primary.id)] : [])))
  const fields = { language, title: t.title, subtitle: t.subtitle, sortTitle: sort }
  if (primary) await tx.update(workTitles).set(fields).where(eq(workTitles.id, primary.id))
  else await tx.insert(workTitles).values({ workId, ...fields, primary: true })
}

/**
 * A merge carries the source's titles in languages the target lacks, as non-primary rows. Returns the lines for
 * `dropped`: titles that lost to the target's own title in the same language.
 */
export async function moveTitles(tx: Db, fromWorkId: string, toWorkId: string): Promise<string[]> {
  const source = await tx.select().from(workTitles).where(eq(workTitles.workId, fromWorkId)).orderBy(sql`${workTitles.primary} desc`, workTitles.id)
  const dropped: string[] = []
  for (const row of source) {
    const [held] = await tx.select({ title: workTitles.title }).from(workTitles).where(and(eq(workTitles.workId, toWorkId), sameLanguage(row.language)))
    if (held === undefined) {
      await tx.insert(workTitles).values({ workId: toWorkId, language: row.language, title: row.title, subtitle: row.subtitle, sortTitle: row.sortTitle, primary: false })
    } else if (held.title !== row.title) {
      dropped.push(`Title “${row.title}”`)
    }
  }
  return dropped
}

/**
 * One field of the title a book shows (#145): the title in the first of `languages` that has one, else the primary.
 * The order is total (language position, primary, id), so the title, subtitle and sort_title subqueries all pick the
 * same row: a picked English title with no subtitle shows no subtitle, never the Hebrew primary's.
 */
export function shownTitleField(workIdCol: AnyColumn | SQL, languages: readonly string[], field: 'title' | 'sort_title'): SQL<string>
export function shownTitleField(workIdCol: AnyColumn | SQL, languages: readonly string[], field: 'subtitle'): SQL<string | null>
export function shownTitleField(workIdCol: AnyColumn | SQL, languages: readonly string[], field: 'title' | 'subtitle' | 'sort_title'): SQL<string> | SQL<string | null>
export function shownTitleField(workIdCol: AnyColumn | SQL, languages: readonly string[], field: 'title' | 'subtitle' | 'sort_title'): SQL {
  const workId = outer(workIdCol)
  const langs = languageArray(languages)
  const wt = alias(workTitles, 'wt') // aliased: the caller may pass work_title.work_id
  const column = { title: wt.title, subtitle: wt.subtitle, sort_title: wt.sortTitle }[field]
  return sql`(select ${column} from ${workTitles} "wt"
    where ${wt.workId} = ${workId} and (${wt.language} = any(${langs}) or ${wt.primary})
    order by array_position(${langs}, ${wt.language}) nulls last, ${wt.primary} desc, ${wt.id}
    limit 1)`
}

/** The work_title row an edition shows when it has no title of its own: its language's, else the primary. */
function editionWorkTitle(editionIdCol: AnyColumn | SQL, field: 'title' | 'subtitle'): SQL {
  const editionId = outer(editionIdCol)
  const wt = alias(workTitles, 'et')
  const te = alias(editions, 'title_edition')
  return sql`(select ${field === 'title' ? wt.title : wt.subtitle} from ${workTitles} "et"
    join ${editions} "title_edition" on ${te.workId} = ${wt.workId}
    where ${te.id} = ${editionId} and (${wt.language} = ${te.language} or ${wt.primary})
    order by (${wt.language} = ${te.language}) desc nulls last, ${wt.primary} desc, ${wt.id}
    limit 1)`
}

/** The edition's own title or subtitle; aliased, because the caller's `edition` is the outer table. */
function ownEditionField(editionIdCol: AnyColumn | SQL, field: 'title' | 'subtitle'): SQL {
  const oe = alias(editions, 'oe')
  return sql`(select ${field === 'title' ? oe.title : oe.subtitle} from ${editions} "oe" where ${oe.id} = ${outer(editionIdCol)})`
}

/** An edition's title (#145): its own; else the book's title in the edition's language; else the primary. */
export function shownEditionTitle(editionIdCol: AnyColumn | SQL): SQL<string> {
  const own = ownEditionField(editionIdCol, 'title')
  return sql<string>`coalesce(${own}, ${editionWorkTitle(editionIdCol, 'title')})`
}

/** The subtitle that goes with `shownEditionTitle`: the edition's own when it has its own title, else the picked row's. */
export function shownEditionSubtitle(editionIdCol: AnyColumn | SQL): SQL<string | null> {
  const ownTitle = ownEditionField(editionIdCol, 'title')
  const ownSubtitle = ownEditionField(editionIdCol, 'subtitle')
  return sql<string | null>`case when ${ownTitle} is not null then ${ownSubtitle} else ${editionWorkTitle(editionIdCol, 'subtitle')} end`
}

// ---- title CRUD (#145) -----------------------------------------------------

type TitleRow = typeof workTitles.$inferSelect
type WorkProvenance = typeof works.$inferSelect.provenance

async function lockWork(tx: Db, scope: UserScope, workId: string): Promise<{ provenance: WorkProvenance }> {
  const [work] = await tx.select({ provenance: works.provenance }).from(works).where(and(eq(works.id, workId), scope.visible)).for('update')
  if (!work) throw notFound('Book')
  return work
}

/** Locks the book of a title I can see (the title is read unlocked first for its book, then re-read under the lock). */
async function lockTitle(tx: Db, scope: UserScope, titleId: string): Promise<{ row: TitleRow; others: TitleRow[]; provenance: WorkProvenance }> {
  const [first] = await tx.select({ workId: workTitles.workId }).from(workTitles).where(eq(workTitles.id, titleId))
  if (!first) throw notFound('Title')
  const { provenance } = await lockWork(tx, scope, first.workId)
  const all = await tx.select().from(workTitles).where(eq(workTitles.workId, first.workId)).orderBy(workTitles.id)
  const row = all.find((r) => r.id === titleId)
  if (!row) throw notFound('Title')
  return { row, others: all.filter((r) => r.id !== titleId), provenance }
}

function refuseTakenLanguage(others: readonly TitleRow[], language: string | null): void {
  if (others.some((r) => r.language === language)) throw new DomainError('CONFLICT', 'It already has a title in that language')
}

/**
 * A title edit is a manual one: source syncs stop touching what it wrote. `fields` are the provenance fields to lock:
 * 'title' always, plus 'subtitle' whenever work.* itself was rewritten (a sync would otherwise overwrite that subtitle).
 */
async function finishTitleEdit(tx: Db, workId: string, provenance: WorkProvenance, fields: readonly string[] = ['title']): Promise<void> {
  await tx.update(works).set({ provenance: markManual(provenance, fields, new Date()) }).where(eq(works.id, workId))
  await refreshSearchDocument(tx, workId)
}

/** Flips the primary flag onto `row` and copies it into work.*; the old primary is cleared first, for the partial unique index. */
async function promote(tx: Db, workId: string, row: TitleRow): Promise<void> {
  await tx.update(workTitles).set({ primary: false }).where(and(eq(workTitles.workId, workId), eq(workTitles.primary, true)))
  await tx.update(workTitles).set({ primary: true }).where(eq(workTitles.id, row.id))
  await tx.update(works).set({ title: row.title, subtitle: row.subtitle, sortTitle: row.sortTitle }).where(eq(works.id, workId))
}

export async function addWorkTitle(db: Db, scope: UserScope, input: AddWorkTitleInput): Promise<{ titleId: string }> {
  return db.transaction(async (tx) => {
    const { provenance } = await lockWork(tx, scope, input.workId)
    refuseTakenLanguage(await tx.select().from(workTitles).where(eq(workTitles.workId, input.workId)), input.language)
    const [row] = await tx
      .insert(workTitles)
      .values({ workId: input.workId, language: input.language, title: input.title, subtitle: input.subtitle, sortTitle: sortTitle(input.title), primary: false })
      .returning({ id: workTitles.id })
    if (!row) throw new Error('title insert failed')
    await finishTitleEdit(tx, input.workId, provenance)
    return { titleId: row.id }
  })
}

export async function updateWorkTitle(db: Db, scope: UserScope, input: UpdateWorkTitleInput): Promise<void> {
  await db.transaction(async (tx) => {
    const { row, others, provenance } = await lockTitle(tx, scope, input.titleId)
    refuseTakenLanguage(others, input.language)
    if (row.primary) {
      await setPrimaryTitle(tx, row.workId, { title: input.title, subtitle: input.subtitle, language: input.language })
    } else {
      await tx
        .update(workTitles)
        .set({ language: input.language, title: input.title, subtitle: input.subtitle, sortTitle: sortTitle(input.title) })
        .where(eq(workTitles.id, row.id))
    }
    await finishTitleEdit(tx, row.workId, provenance, row.primary ? ['title', 'subtitle'] : ['title'])
  })
}

/**
 * Removes a title. Removing the primary promotes `newPrimaryId`, else the row in the remover's first language, else the
 * first by id (the table keeps no creation time).
 */
export async function removeWorkTitle(db: Db, scope: UserScope, input: RemoveWorkTitleInput): Promise<void> {
  await db.transaction(async (tx) => {
    const { row, others, provenance } = await lockTitle(tx, scope, input.titleId)
    if (others.length === 0) throw new DomainError('INVALID', 'A book needs a title')
    let successor: TitleRow | undefined
    if (row.primary) {
      if (input.newPrimaryId !== null) {
        successor = others.find((r) => r.id === input.newPrimaryId)
        if (!successor) throw new DomainError('INVALID', "Pick one of the book's other titles to take over")
      } else {
        const rank = (r: TitleRow) => {
          const i = scope.languages.indexOf(r.language ?? '')
          return i === -1 ? Number.MAX_SAFE_INTEGER : i
        }
        successor = [...others].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0]
      }
    }
    await tx.delete(workTitles).where(eq(workTitles.id, row.id))
    if (successor) await promote(tx, row.workId, successor)
    await finishTitleEdit(tx, row.workId, provenance, successor ? ['title', 'subtitle'] : ['title'])
  })
}

export async function makeTitlePrimary(db: Db, scope: UserScope, input: TitleIdInput): Promise<void> {
  await db.transaction(async (tx) => {
    const { row, provenance } = await lockTitle(tx, scope, input.titleId)
    if (!row.primary) await promote(tx, row.workId, row)
    await finishTitleEdit(tx, row.workId, provenance, row.primary ? ['title'] : ['title', 'subtitle'])
  })
}
