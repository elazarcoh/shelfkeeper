import { CreateSourceInput, SourceSchedule, UpdateSourceInput, type PublicSourceConfig, type SyncedSourceKind } from '@mylib/domain'

// the kind names are `sourceKindLabel` in `@/lib/format` (it covers every kind) — don't define a second copy here

export const secretLabel: Record<SyncedSourceKind, string> = { audiobookshelf: 'API token', calibre: 'Password', readarr: 'API key', chaptarr: 'API key' }

export interface SourceForm {
  kind: SyncedSourceKind
  name: string
  baseUrl: string
  /** the kind's secret (token, password or API key); blank on edit = keep the stored one */
  secret: string
  /** Audiobookshelf: comma-separated; blank = every book library */
  libraryIds: string
  /** Calibre: blank = no login */
  username: string
  /** Calibre: blank = the server's default library */
  libraryId: string
  /** Calibre: e.g. #words; blank = none */
  wordCountColumn: string
  schedule: '' | SourceSchedule
  /** edit only: a secret is stored, so a blank one keeps it */
  hasSecret: boolean
}

export const emptySourceForm = (kind: SyncedSourceKind): SourceForm => ({
  kind,
  name: '',
  baseUrl: '',
  secret: '',
  libraryIds: '',
  username: '',
  libraryId: '',
  wordCountColumn: '',
  schedule: '',
  hasSecret: false,
})

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

export function parseLibraryIds(text: string): string[] | null {
  const ids = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return ids.length === 0 ? null : ids
}

const blankToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim())

export function sourceFormFrom(view: { name: string; schedule: SourceSchedule | null; config: PublicSourceConfig }): SourceForm {
  const c = view.config
  return {
    ...emptySourceForm(c.kind),
    name: view.name,
    baseUrl: c.baseUrl,
    schedule: view.schedule ?? '',
    libraryIds: c.kind === 'audiobookshelf' ? (c.libraryIds ?? []).join(', ') : '',
    username: c.kind === 'calibre' ? (c.username ?? '') : '',
    libraryId: c.kind === 'calibre' ? (c.libraryId ?? '') : '',
    wordCountColumn: c.kind === 'calibre' ? (c.wordCountColumn ?? '') : '',
    hasSecret: c.hasSecret,
  }
}

const HALF_LOGIN = 'Calibre needs both a username and a password'

/** Calibre with a username but no password (typed, or kept from before) would silently log in as nobody. */
function halfLogin(form: SourceForm, mode: 'create' | 'update'): boolean {
  if (form.kind !== 'calibre' || blankToNull(form.username) === null || form.secret.trim() !== '') return false
  return mode === 'create' || !form.hasSecret
}

/** On update a blank secret is left out (keep the stored one); Calibre without a username has no password at all. */
function configOf(form: SourceForm, mode: 'create' | 'update'): Record<string, unknown> {
  const base = { kind: form.kind, baseUrl: form.baseUrl.trim() }
  const secret = form.secret.trim() === '' ? undefined : form.secret
  const required = secret ?? (mode === 'create' ? '' : undefined)
  switch (form.kind) {
    case 'audiobookshelf':
      return { ...base, apiToken: required, libraryIds: parseLibraryIds(form.libraryIds) }
    case 'calibre': {
      const username = blankToNull(form.username)
      const password = username === null ? null : (secret ?? (mode === 'create' ? null : undefined))
      return { ...base, username, password, libraryId: blankToNull(form.libraryId), wordCountColumn: blankToNull(form.wordCountColumn) }
    }
    case 'readarr':
    case 'chaptarr':
      return { ...base, apiKey: required }
  }
}

const fieldLabels: Record<string, string> = {
  baseUrl: 'Server URL',
  apiToken: 'API token',
  apiKey: 'API key',
  password: 'Password',
  username: 'Username',
  libraryId: 'Library',
  wordCountColumn: 'Word count column',
  name: 'Name',
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  if (!issue) return 'Please check the form'
  const field = issue.path.at(-1)
  const label = typeof field === 'string' ? fieldLabels[field] : undefined
  return label === undefined ? issue.message : `${label}: ${issue.message}`
}

const withoutUndefined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

export function toCreateInput(form: SourceForm): Parsed<CreateSourceInput> {
  if (halfLogin(form, 'create')) return { ok: false, message: HALF_LOGIN }
  const parsed = CreateSourceInput.safeParse({ name: form.name, schedule: form.schedule === '' ? null : form.schedule, config: configOf(form, 'create') })
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: firstIssue(parsed.error) }
}

export function toUpdatePatch(form: SourceForm): Parsed<UpdateSourceInput> {
  if (halfLogin(form, 'update')) return { ok: false, message: HALF_LOGIN }
  const parsed = UpdateSourceInput.safeParse({
    name: form.name,
    schedule: form.schedule === '' ? null : form.schedule,
    config: withoutUndefined(configOf(form, 'update')),
  })
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: firstIssue(parsed.error) }
}
