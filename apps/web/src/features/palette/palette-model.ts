import { normalizeText, tokenize, type WorkCard } from '@mylib/domain'

export type PagePath =
  | '/' | '/library' | '/sets' | '/wishlist' | '/loans' | '/stats' | '/inbox' | '/account'
  | '/books/new' | '/books/shelf' | '/books/import'
  | '/admin' | '/admin/sets' | '/admin/sources' | '/admin/jobs' | '/admin/backups' | '/admin/loans' | '/admin/volumes' | '/admin/system'

export type LibraryLink = { scope: 'catalog'; authorIds?: [string]; seriesIds?: [string]; tagIds?: [string]; set?: string }

export type PaletteTarget =
  | { kind: 'page'; to: PagePath }
  | { kind: 'library'; search: LibraryLink }
  | { kind: 'user'; userId: string }
  | { kind: 'checkin' }
  | { kind: 'book'; card: WorkCard }

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  target: PaletteTarget
}

export type GroupId = 'actions' | 'books' | 'pages' | 'authors' | 'series' | 'sets' | 'tags' | 'people'

export interface PaletteGroup {
  id: GroupId
  heading: string
  items: PaletteItem[]
}

export interface PaletteSources {
  books: readonly WorkCard[] | undefined
  authors: readonly { id: string; name: string }[] | undefined
  series: readonly { id: string; name: string }[] | undefined
  tags: readonly { id: string; name: string }[] | undefined
  sets: readonly { id: string; name: string }[] | undefined
  /** admins only (admin.list); undefined for members */
  users: readonly { id: string; displayName: string; username: string }[] | undefined
  borrowers: readonly string[] | undefined
}

/** Entries per client-filtered group while there is a query. */
export const GROUP_CAP = 5

/** Every page a person can open; labels match the sidebar where it has them. */
export const PAGES: readonly { label: string; to: PagePath; keywords?: string; adminOnly?: boolean }[] = [
  { label: 'Home', to: '/', keywords: 'start dashboard' },
  { label: 'Library', to: '/library', keywords: 'books catalog browse' },
  { label: 'Sets', to: '/sets', keywords: 'lists collections' },
  { label: 'Wishlist', to: '/wishlist', keywords: 'wish gifts want buy' },
  { label: 'Lent out', to: '/loans', keywords: 'who has my books loans borrowed lend' },
  { label: 'Stats', to: '/stats', keywords: 'statistics goals numbers' },
  { label: 'Inbox', to: '/inbox', keywords: 'new imported review' },
  { label: 'Account', to: '/account', keywords: 'profile password pin settings' },
  { label: 'Admin', to: '/admin', keywords: 'users accounts household', adminOnly: true },
  { label: 'Sets (admin)', to: '/admin/sets', keywords: 'global sets', adminOnly: true },
  { label: 'Sources', to: '/admin/sources', keywords: 'audiobookshelf calibre readarr chaptarr sync', adminOnly: true },
  { label: 'Jobs', to: '/admin/jobs', keywords: 'queue worker', adminOnly: true },
  { label: 'Backups', to: '/admin/backups', keywords: 'restore', adminOnly: true },
  { label: 'Loans (admin)', to: '/admin/loans', keywords: 'lent borrowed', adminOnly: true },
  { label: 'Volumes', to: '/admin/volumes', keywords: 'multi volume merge parts', adminOnly: true },
  { label: 'System', to: '/admin/system', keywords: 'health version', adminOnly: true },
]

export const ACTIONS: readonly { id: string; label: string; target: PaletteTarget; keywords?: string }[] = [
  { id: 'action:checkin', label: 'Check in', target: { kind: 'checkin' }, keywords: 'progress reading today' },
  { id: 'action:add', label: 'Add a book', target: { kind: 'page', to: '/books/new' }, keywords: 'new create' },
  { id: 'action:shelf', label: 'Add from shelf', target: { kind: 'page', to: '/books/shelf' }, keywords: 'photo camera ai' },
  { id: 'action:import', label: 'Import a CSV file', target: { kind: 'page', to: '/books/import' }, keywords: 'csv goodreads spreadsheet' },
]

/**
 * 0: the whole label starts with the query; 1: every query token is a prefix of some token of the label or keywords;
 * null: no match (and always null for an empty query).
 */
export function matchLabel(query: string, label: string, keywords?: string): 0 | 1 | null {
  const q = tokenize(query)
  if (q.length === 0) return null
  if (normalizeText(label).startsWith(q.join(' '))) return 0
  const words = tokenize(keywords === undefined ? label : `${label} ${keywords}`)
  return q.every((t) => words.some((w) => w.startsWith(t))) ? 1 : null
}

export function libraryLink(kind: 'author' | 'series' | 'tag' | 'set', id: string): LibraryLink {
  switch (kind) {
    case 'author':
      return { scope: 'catalog', authorIds: [id] }
    case 'series':
      return { scope: 'catalog', seriesIds: [id] }
    case 'tag':
      return { scope: 'catalog', tagIds: [id] }
    case 'set':
      return { scope: 'catalog', set: id }
  }
}

/** The item without its search-only keywords. */
function plain({ id, label, hint, target }: PaletteItem & { keywords?: string }): PaletteItem {
  return { id, label, ...(hint === undefined ? {} : { hint }), target }
}

/** The matches among `items`, best first, at most GROUP_CAP. */
function filtered(query: string, items: readonly (PaletteItem & { keywords?: string })[]): PaletteItem[] {
  return items
    .flatMap((item) => {
      const rank = matchLabel(query, item.label, item.keywords)
      return rank === null ? [] : [{ item, rank }]
    })
    .sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label))
    .slice(0, GROUP_CAP)
    .map(({ item }) => plain(item))
}

/** The palette's groups for this query, in display order, empty ones left out. */
export function paletteGroups(query: string, sources: PaletteSources, opts: { isAdmin: boolean }): PaletteGroup[] {
  const pages = PAGES.filter((p) => opts.isAdmin || p.adminOnly !== true).map((p) => ({
    id: `page:${p.to}`,
    label: p.label,
    target: { kind: 'page', to: p.to } as const,
    ...(p.keywords === undefined ? {} : { keywords: p.keywords }),
  }))
  const actions = ACTIONS.map((a) => ({ id: a.id, label: a.label, target: a.target, ...(a.keywords === undefined ? {} : { keywords: a.keywords }) }))
  const strip = (items: (PaletteItem & { keywords?: string })[]): PaletteItem[] => items.map(plain)

  if (tokenize(query).length === 0) {
    return [
      { id: 'actions', heading: 'Actions', items: strip(actions) },
      { id: 'pages', heading: 'Pages', items: strip(pages) },
    ]
  }

  const named = (prefix: string, kind: 'author' | 'series' | 'tag' | 'set', list: readonly { id: string; name: string }[] | undefined) =>
    filtered(query, (list ?? []).map((x) => ({ id: `${prefix}:${x.id}`, label: x.name, target: { kind: 'library', search: libraryLink(kind, x.id) } as const })))

  const people = [
    ...(opts.isAdmin ? (sources.users ?? []) : []).map((u) => ({ id: `user:${u.id}`, label: u.displayName, hint: `@${u.username}`, keywords: u.username, target: { kind: 'user', userId: u.id } as const })),
    ...(sources.borrowers ?? []).map((name) => ({ id: `borrower:${name}`, label: name, hint: 'Lent out', target: { kind: 'page', to: '/loans' } as const })),
  ]

  const groups: PaletteGroup[] = [
    { id: 'actions', heading: 'Actions', items: filtered(query, actions) },
    {
      id: 'books',
      heading: 'Books',
      items: (sources.books ?? []).map((card) => ({
        id: `book:${card.id}`,
        label: card.title,
        ...(card.authors.length > 0 ? { hint: card.authors.join(', ') } : {}),
        target: { kind: 'book', card } as const,
      })),
    },
    { id: 'pages', heading: 'Pages', items: filtered(query, pages) },
    { id: 'authors', heading: 'Authors', items: named('author', 'author', sources.authors) },
    { id: 'series', heading: 'Series', items: named('series', 'series', sources.series) },
    { id: 'sets', heading: 'Sets', items: named('set', 'set', sources.sets) },
    { id: 'tags', heading: 'Tags', items: named('tag', 'tag', sources.tags) },
    { id: 'people', heading: 'People', items: filtered(query, people) },
  ]
  return groups.filter((g) => g.items.length > 0)
}
