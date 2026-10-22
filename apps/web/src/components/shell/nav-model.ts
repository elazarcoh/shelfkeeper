export type TabId = 'home' | 'library' | 'stats' | 'inbox' | 'me'
export type TabRoot = '/' | '/library' | '/stats' | '/inbox' | '/account'
export interface TabDef {
  id: TabId
  to: TabRoot
  label: string
}

/** The phone bottom bar: exactly these five, in this order. Sets lives inside Library; Admin inside Me. */
export const TABS: readonly TabDef[] = [
  { id: 'home', to: '/', label: 'Home' },
  { id: 'library', to: '/library', label: 'Library' },
  { id: 'stats', to: '/stats', label: 'Stats' },
  { id: 'inbox', to: '/inbox', label: 'Inbox' },
  { id: 'me', to: '/account', label: 'Me' },
]

function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

const ADD_BOOK_PATHS: readonly string[] = ['/books/new', '/books/import']

export function tabForPath(pathname: string): TabId | null {
  const p = normalize(pathname)
  if (p === '/' || under(p, '/next')) return 'home'
  // adding a book is the top bar's ＋, open from every tab, so it is no tab's page
  if (ADD_BOOK_PATHS.includes(p)) return null
  if (under(p, '/library') || under(p, '/sets') || under(p, '/wishlist') || under(p, '/loans') || under(p, '/books')) return 'library'
  if (under(p, '/stats')) return 'stats'
  if (under(p, '/inbox')) return 'inbox'
  if (under(p, '/account') || under(p, '/admin')) return 'me'
  return null
}

export function isRootPath(pathname: string): boolean {
  const p = normalize(pathname)
  return TABS.some((t) => t.to === p)
}

export function titleForPath(pathname: string): string {
  const p = normalize(pathname)
  if (p === '/books/new') return 'Add a book'
  if (p === '/books/import') return 'Import a CSV file'
  if (under(p, '/books')) return 'Book'
  if (under(p, '/sets')) return 'Sets'
  if (under(p, '/wishlist')) return 'Wishlist'
  if (under(p, '/loans')) return 'Who has my books'
  if (under(p, '/next')) return 'What next?'
  if (under(p, '/admin')) return 'Admin'
  if (under(p, '/account')) return 'Account'
  if (p === '/') return 'My Library'
  return TABS.find((t) => t.to === p)?.label ?? 'My Library'
}

/** Where Back goes when there is no in-app history (a deep link opened in the installed app). */
export function backFallback(pathname: string): TabRoot {
  // a new book lands in the Library, so that is where Back goes from adding one
  if (ADD_BOOK_PATHS.includes(normalize(pathname))) return '/library'
  const tab = tabForPath(pathname)
  return TABS.find((t) => t.id === tab)?.to ?? '/'
}

/** The top bar's Back: step back through in-app history, or, with none, open the tab's main page (never leave the app). */
export function goBack(opts: { pathname: string; canGoBack: boolean; back: () => void; navigate: (to: TabRoot) => void }): void {
  if (opts.canGoBack) opts.back()
  else opts.navigate(backFallback(opts.pathname))
}

export function inboxLabel(count: number | undefined): string {
  return count !== undefined && count > 0 ? `Inbox, ${count} waiting` : 'Inbox'
}

export function inboxBadge(count: number | undefined): string | null {
  if (count === undefined || count <= 0) return null
  return count > 99 ? '99+' : String(count)
}
