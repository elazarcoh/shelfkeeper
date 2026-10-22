import { formatSeriesPosition, parseSeriesPosition, type WorkKind } from '@mylib/domain'
import { changedFields, emptyToNull, parseCommaList, parseLines, toNumberOrNull } from '@/lib/form'
import type { RouterOutputs } from '@/lib/trpc'

type WorkDetail = RouterOutputs['catalog']['get']

export interface SeriesRow {
  name: string
  position: string
}

export interface WorkFormState {
  title: string
  subtitle: string
  description: string
  originalYear: string
  /** one per line */
  authors: string
  /** comma separated */
  tags: string
  series: SeriesRow[]
  kind: WorkKind
  /** the shown title row when it is not the primary: Title/Subtitle edit that row (#145) */
  titleId?: string | undefined
  /** the person used the Kind select: the kind is sent (and locked) even when it equals the old one */
  kindTouched?: boolean
}

export const emptyWorkForm = (): WorkFormState => ({
  title: '',
  subtitle: '',
  description: '',
  originalYear: '',
  authors: '',
  tags: '',
  series: [],
  kind: 'book',
})

export function workFormFromDetail(
  w: Pick<WorkDetail, 'title' | 'subtitle' | 'titleId' | 'titles' | 'description' | 'originalYear' | 'authors' | 'tags' | 'series' | 'kind'>,
): WorkFormState {
  return {
    // the shown row's own text; a save edits that row (titleId), so it never rewrites the primary with another language's text (#145)
    title: w.title,
    subtitle: w.subtitle ?? '',
    titleId: w.titles.some((t) => t.id === w.titleId && t.primary) ? undefined : w.titleId,
    description: w.description ?? '',
    originalYear: w.originalYear === null ? '' : String(w.originalYear),
    authors: w.authors.map((a) => a.creditedName).join('\n'),
    tags: w.tags.map((t) => t.name).join(', '),
    series: w.series.map((s) => ({ name: s.name, position: formatSeriesPosition(s.position, s.positionEnd) })),
    kind: w.kind,
  }
}

/** The form with only its title fields (title, subtitle, titleId) taken from a fresh `initial`; the person's other unsaved edits stay (#145). */
export function withTitlesFrom(form: WorkFormState, initial: WorkFormState): WorkFormState {
  return { ...form, title: initial.title, subtitle: initial.subtitle, titleId: initial.titleId }
}

export function workFormToInput(s: WorkFormState) {
  return {
    title: s.title,
    subtitle: emptyToNull(s.subtitle),
    description: emptyToNull(s.description),
    originalYear: toNumberOrNull(s.originalYear),
    authors: parseLines(s.authors),
    tags: parseCommaList(s.tags),
    series: s.series
      .filter((row) => row.name.trim() !== '')
      // unreadable text becomes NaN so validation names the row (#122)
      .map((row) => ({ name: row.name.trim(), ...(parseSeriesPosition(row.position) ?? { position: Number.NaN, positionEnd: null }) })),
    kind: s.kind,
  }
}

/** What changed from the initial form; a touched Kind is always sent, so choosing Book by hand locks it. */
export function workPatchFromForm(initial: WorkFormState, form: WorkFormState) {
  const changed = changedFields(workFormToInput(initial), workFormToInput(form))
  const withKind = form.kindTouched ? { ...changed, kind: form.kind } : changed
  return form.titleId !== undefined && (withKind.title !== undefined || withKind.subtitle !== undefined) ? { ...withKind, titleId: form.titleId } : withKind
}
