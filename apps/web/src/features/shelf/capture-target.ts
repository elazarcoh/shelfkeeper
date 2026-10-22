import { PageCapture } from '@mylib/domain'

export const TARGET_KEY = 'mylib.shelf.target'
export const RECEIVED_KEY = 'mylib.shelf.received'
const TTL_MS = 10 * 60_000
const RECEIVED_MS = 60_000

export type CaptureTarget = { kind: 'row'; key: string } | { kind: 'proposal'; id: string } | { kind: 'work'; id: string } | { kind: 'edition'; id: string } | { kind: 'search' }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

/** localStorage, or a store that forgets when the browser refuses it (private windows, blocked site data). */
export function safeStorage(): Storage {
  try {
    return localStorage
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  }
}

/** What the next page sent back by the bookmarklet is for: remembered when the person taps Find. */
export function rememberTarget(target: CaptureTarget, storage: Storage = safeStorage(), now = Date.now()): void {
  try {
    storage.setItem(TARGET_KEY, JSON.stringify({ target, at: now }))
  } catch {
    // no storage: the capture then opens the single-book review
  }
}

const isTarget = (v: unknown): v is CaptureTarget => {
  if (v === null || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return t['kind'] === 'search' || (t['kind'] === 'row' && typeof t['key'] === 'string') || ((t['kind'] === 'proposal' || t['kind'] === 'work' || t['kind'] === 'edition') && typeof t['id'] === 'string')
}

/** The remembered target, once: an expired or unreadable one is dropped, and one of another kind is left for its own page. */
export function takeTarget(storage: Storage = safeStorage(), now = Date.now(), kinds?: readonly CaptureTarget['kind'][]): CaptureTarget | null {
  try {
    const raw = storage.getItem(TARGET_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { target?: unknown; at?: unknown }
    const fresh = typeof parsed.at === 'number' && now - parsed.at <= TTL_MS && isTarget(parsed.target)
    if (fresh && kinds !== undefined && !kinds.includes((parsed.target as CaptureTarget).kind)) return null
    storage.removeItem(TARGET_KEY)
    return fresh ? (parsed.target as CaptureTarget) : null
  } catch {
    return null
  }
}

/** Notes a page the app received by message, so a late #capture= fallback for the same page is not applied again. */
export function rememberReceived(url: string, storage: Storage = safeStorage(), now = Date.now()): void {
  try {
    storage.setItem(RECEIVED_KEY, JSON.stringify({ url, at: now }))
  } catch {
    // no storage: a late fallback then opens the single-book review
  }
}

/** Whether `url` came by message within the last minute (the bookmarklet heard the app's answer too late). */
export function wasJustReceived(url: string, storage: Storage = safeStorage(), now = Date.now()): boolean {
  try {
    const raw = storage.getItem(RECEIVED_KEY)
    if (raw === null) return false
    const parsed = JSON.parse(raw) as { url?: unknown; at?: unknown }
    return parsed.url === url && typeof parsed.at === 'number' && now - parsed.at >= 0 && now - parsed.at <= RECEIVED_MS
  } catch {
    return false
  }
}

/** `#capture=<encoded JSON>`: how the bookmarklet opens this page when the window that sent the person to Simania is gone. */
export function captureFromHash(hash: string): PageCapture | null {
  const prefix = '#capture='
  if (!hash.startsWith(prefix)) return null
  try {
    const parsed = PageCapture.safeParse(JSON.parse(decodeURIComponent(hash.slice(prefix.length))))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
