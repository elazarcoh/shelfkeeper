import { useLayoutEffect } from 'react'

/** How far a page's sticky bars reach below the top bar: the tallest one that is sticky right now, rounded up. */
export function stickyBarOffset(bars: readonly { sticky: boolean; height: number }[]): number {
  return Math.ceil(Math.max(0, ...bars.filter((b) => b.sticky).map((b) => b.height)))
}

/**
 * Publishes the real height of this page's `[data-sticky-bar]` elements as `--page-sticky-h` on <html>, so
 * scroll-padding-top keeps a focused element clear of a bar whose buttons wrap. Re-measures when a bar resizes
 * or the viewport crosses lg (where the bars stop being sticky). `key` changes when bars appear or disappear.
 */
export function usePageStickyBarHeight(key: string): void {
  useLayoutEffect(() => {
    const root = document.documentElement
    const bars = [...document.querySelectorAll<HTMLElement>('[data-sticky-bar]')]
    const update = () => {
      const offset = stickyBarOffset(bars.map((el) => ({ sticky: getComputedStyle(el).position === 'sticky', height: el.getBoundingClientRect().height })))
      root.style.setProperty('--page-sticky-h', `${offset}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    for (const el of bars) observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      root.style.removeProperty('--page-sticky-h')
    }
  }, [key])
}
