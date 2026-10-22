import { useCallback, useSyncExternalStore } from 'react'

// one MediaQueryList per query, shared by every subscriber (getSnapshot runs on every render)
const lists = new Map<string, MediaQueryList>()
function mediaQueryList(query: string): MediaQueryList {
  let mql = lists.get(query)
  if (mql === undefined) {
    mql = window.matchMedia(query)
    lists.set(query, mql)
  }
  return mql
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = mediaQueryList(query)
      mql.addEventListener('change', onChange)
      return () => {
        mql.removeEventListener('change', onChange)
      }
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => mediaQueryList(query).matches, () => false)
}
