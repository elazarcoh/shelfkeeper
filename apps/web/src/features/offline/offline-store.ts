import type { OfflineSnapshot } from '@mylib/domain'

/** #62: the phone's offline copy of the catalog, of the person last signed in on this device. */
export interface SavedCopy {
  userId: string
  name: string
  snapshot: OfflineSnapshot
}

const DB = 'mylib-offline'
const STORE = 'copy'
const KEY = 'current'
/** a copy older than this is fetched again when the app opens (or while it stays open) */
export const REFRESH_MS = 6 * 60 * 60_000

/** Whether the saved copy should be replaced: none yet, another person's, or older than REFRESH_MS. */
export function needsRefresh(saved: Pick<SavedCopy, 'userId' | 'snapshot'> | null, userId: string, now = Date.now()): boolean {
  if (saved === null || saved.userId !== userId) return true
  const at = Date.parse(saved.snapshot.at)
  return Number.isNaN(at) || now - at >= REFRESH_MS || at > now
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
  })
}

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'))
    })
  } finally {
    db.close()
  }
}

/** The saved copy, or null when there is none or the browser keeps no storage (private windows). */
export async function loadCopy(): Promise<SavedCopy | null> {
  try {
    return ((await run('readonly', (s) => s.get(KEY) as IDBRequest<SavedCopy | undefined>)) ?? null)
  } catch {
    return null
  }
}

export async function saveCopy(copy: SavedCopy): Promise<void> {
  await run('readwrite', (s) => s.put(copy, KEY))
}

/** On sign-out: the next person on this phone doesn't see the last one's books. */
export async function clearCopy(): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(KEY))
  } catch {
    // no storage, nothing saved
  }
}
