import type { Page } from '@playwright/test'

/** The widths every layout check runs at (zz-layout's sweep, the /setup sweep). */
export const WIDTHS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 600, height: 960 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  // desktop: sidebar plus inline filters, mouse only (newContext gives a touch screen only below 1024px)
  { width: 1280, height: 800 },
]

export interface LayoutReport {
  scrollWidth: number
  innerWidth: number
  /** px of the page's last content that sits under the fixed bottom bar after scrolling to the end (0 = clear) */
  hiddenBehindNav: number
  /** up to five elements sticking out past the right edge, for the failure message */
  offenders: string[]
}

export async function measureLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const describe = (el: Element) => {
      // SVG elements have no innerText
      const raw = el.getAttribute('aria-label') ?? (el instanceof HTMLElement ? el.innerText : el.textContent)
      const text = raw.trim().replace(/\s+/g, ' ').slice(0, 40)
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${text ? ` "${text}"` : ''}`
    }
    const insideScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const x = getComputedStyle(p).overflowX
        if (x === 'auto' || x === 'scroll' || x === 'hidden') return true
      }
      return false
    }
    const pinned = (el: Element, stop: Element) => {
      for (let p: Element | null = el; p && p !== stop; p = p.parentElement) {
        const pos = getComputedStyle(p).position
        if (pos === 'fixed' || pos === 'sticky') return true
      }
      return false
    }

    const innerWidth = window.innerWidth
    const scrollWidth = document.documentElement.scrollWidth
    const offenders: string[] = []
    if (scrollWidth > innerWidth) {
      let widest: { el: Element; right: number } | null = null
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (widest === null || r.right > widest.right)) widest = { el, right: r.right }
        if (offenders.length < 5 && r.width > 0 && r.right > innerWidth + 1 && !insideScroller(el)) offenders.push(`${describe(el)} right=${Math.round(r.right)}`)
      }
      // everything sticking out sits inside an overflow-hidden/auto ancestor: name the widest element instead of nothing
      if (offenders.length === 0 && widest !== null) offenders.push(`(widest) ${describe(widest.el)} right=${Math.round(widest.right)}`)
    }

    let hiddenBehindNav = 0
    const nav = document.querySelector('[data-slot="bottom-nav"]')
    const main = document.querySelector('main')
    if (nav && main && getComputedStyle(nav).display !== 'none') {
      // instant: a smooth scroll-behavior would leave the page mid-scroll when it is measured
      window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: 'instant' })
      const { top: navTop, bottom: navBottom } = nav.getBoundingClientRect()
      let last = 0
      // a pinned element (a sticky submit bar) stays where it is however far the page scrolls: it must not sit on the
      // bar either (#9)
      let pinnedUnder = 0
      for (const el of Array.from(main.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue
        if (pinned(el, main)) {
          if (r.top < navBottom) pinnedUnder = Math.max(pinnedUnder, r.bottom - navTop)
          continue
        }
        last = Math.max(last, r.bottom)
      }
      // fractional row heights can leave the last row a fraction of a pixel under the bar: Math.round plus the
      // spec's <= 1 gives about 1px of tolerance
      hiddenBehindNav = Math.max(0, Math.round(last - navTop), Math.round(pinnedUnder))
    }
    return { scrollWidth, innerWidth, hiddenBehindNav, offenders }
  })
}

/** 150 characters with no break opportunity: one long name, a URL, a title in a script without spaces. */
export const LONG_UNBROKEN = 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(4).slice(0, 150)
/** 150 characters of ordinary words: wraps anywhere, so it catches nowrap rows (truncate) that never shrink. */
export const LONG_SPACED =
  'The quite remarkably long and winding title of a book that someone typed in full, subtitle and all, just to see what happens next on a small phone okay'.slice(
    0,
    150,
  )

export interface StressOffender {
  /** the stressed element */
  leaf: string
  /** each place on the way up where it sticks out: its own text running past it, then each (parent > child) */
  chain: string[]
}

export interface StressReport {
  stressed: number
  dialogs: number
  scrollWidth: number
  innerWidth: number
  pageOverflow: boolean
  dialogIssues: string[]
  offenders: StressOffender[]
}

/**
 * Long-text stress. Puts `text` into every element meant to cope with long user text (truncate, line-clamp-*,
 * break-words, wrap-break-word, dir="auto"), then measures: does the page (or an open dialog) now scroll sideways,
 * and for each stressed element that sticks out, where. The usual cause is a grid with an implicit auto (or 1fr)
 * column, or a flex item without min-w-0: those grow to the text's one-line width, so truncation never applies.
 * The same logic as the scratchpad sweep the fixes were found with; keep the two identical.
 */
export async function stressLongText(page: Page, text: string): Promise<StressReport> {
  return page.evaluate((text) => {
    const MARKER = /^(truncate|line-clamp-\d+|break-words|wrap-break-word)$/
    const SKIP = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE'])
    const marked = (el: Element) => el.getAttribute('dir') === 'auto' || Array.from(el.classList).some((c) => MARKER.test(c))
    const stressed: Element[] = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (SKIP.has(el.tagName) || !marked(el)) continue
      // only the element's own text: keep React's text nodes (set nodeValue, never replace them)
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? '').trim() !== '')
      const first = own[0]
      if (!first) continue
      first.nodeValue = text
      for (const n of own.slice(1)) n.nodeValue = ''
      stressed.push(el)
    }

    const describe = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 8).join('.') : ''
      const raw = el.getAttribute('aria-label') ?? el.textContent
      const t = raw.trim().replace(/\s+/g, ' ').slice(0, 24)
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${t ? ` "${t}"` : ''}`
    }
    // a deliberate sideways scroller (overflow-x-auto): content inside may be wider than the screen
    const intendedScroller = (el: Element) => Array.from(el.classList).some((c) => /^(overflow-x-(auto|scroll)|overflow-(auto|scroll))$/.test(c))
    const vw = window.innerWidth
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    const pageOverflow = document.documentElement.scrollWidth > vw
    const dialogs = Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog]')).filter(visible)
    const dialogIssues: string[] = []
    for (const d of dialogs) {
      const r = d.getBoundingClientRect()
      if (r.right > vw + 1 || r.left < -1) dialogIssues.push(`dialog off screen left=${Math.round(r.left)} right=${Math.round(r.right)}`)
      for (const s of [d, ...Array.from(d.querySelectorAll('*'))]) {
        const x = getComputedStyle(s).overflowX
        if ((x === 'auto' || x === 'scroll') && !intendedScroller(s) && s.scrollWidth > s.clientWidth + 1) {
          const edge = s.getBoundingClientRect().right
          const out = (e: Element) => e.getBoundingClientRect().right > edge + 1
          const deepest = Array.from(s.querySelectorAll('*'))
            .filter((e) => out(e) && !Array.from(e.children).some(out))
            .slice(0, 3)
            .map(describe)
          dialogIssues.push(`sideways scroll in ${describe(s)} (${s.scrollWidth} > ${s.clientWidth}): ${deepest.join('; ')}`)
        }
      }
    }

    // for each stressed element that is on screen: every (child, parent) link on the way up where the child sticks out
    // of the parent, named by the parent's display (a flex row or a grid whose track did not let the text shrink)
    const offenders: { leaf: string; chain: string[] }[] = []
    const seen = new Set<string>()
    // the element doing the truncating: what sticks out of it is clipped behind its ellipsis, as intended
    const clips = (el: Element) => Array.from(el.classList).some((c) => /^(truncate|line-clamp-\d+|sr-only)$/.test(c))
    for (const leaf of stressed) {
      if (!visible(leaf)) continue
      // inside a sideways scroller, only the scroller itself has to fit
      let start = leaf
      for (let p = leaf.parentElement; p; p = p.parentElement) if (intendedScroller(p)) start = p
      const chain: string[] = []
      if (start === leaf && getComputedStyle(leaf).overflowX === 'visible') {
        // the text itself running past its own box: no wrapping (no break-words) and no truncation
        const range = document.createRange()
        range.selectNodeContents(leaf)
        const tr = range.getBoundingClientRect()
        const lr = leaf.getBoundingClientRect()
        if (tr.right > lr.right + 1 || tr.left < lr.left - 1)
          chain.push(`text runs out of ${describe(leaf)} (+${Math.round(Math.max(tr.right - lr.right, lr.left - tr.left))}px)`)
      }
      for (let c: Element = start, p = start.parentElement; p && p !== document.documentElement; c = p, p = p.parentElement) {
        // a fixed bar (the bottom tabs) spans the layout viewport, which follows the page's width: a symptom, not a cause
        if (clips(p) || getComputedStyle(c).position === 'fixed') break
        const cr = c.getBoundingClientRect()
        const pr = p.getBoundingClientRect()
        // a negative margin (-mx-4 full-bleed) sticks out on purpose, by exactly that much
        const ccs = getComputedStyle(c)
        const bleedR = Math.max(0, -parseFloat(ccs.marginRight) || 0)
        const bleedL = Math.max(0, -parseFloat(ccs.marginLeft) || 0)
        if (cr.right > pr.right + bleedR + 1 || cr.left < pr.left - bleedL - 1) {
          const cs = getComputedStyle(p)
          const kind = cs.display.includes('grid') ? `grid[${cs.gridTemplateColumns.split(' ').length} cols]` : cs.display.includes('flex') ? `flex-${cs.flexDirection}` : cs.display
          chain.push(`${kind} ${describe(p)} > ${describe(c)} (+${Math.round(Math.max(cr.right - pr.right, pr.left - cr.left))}px)`)
        }
      }
      const key = chain[0]
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      offenders.push({ leaf: describe(leaf), chain: chain.slice(0, 4) })
    }
    if (pageOverflow && offenders.length === 0) {
      // nothing stressed explains it: name the text that reaches past the screen
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let named = 0
      for (let n = walker.nextNode(); n && named < 5; n = walker.nextNode()) {
        const el = n.parentElement
        if (!el || !(n.nodeValue ?? '').trim() || el.closest('.sr-only, .truncate, [class*="line-clamp-"], [data-slot="bottom-nav"]')) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        const r = range.getBoundingClientRect()
        if (r.width > 0 && r.right > vw + 1) {
          offenders.push({ leaf: describe(el), chain: [`text reaches ${Math.round(r.right)}px`] })
          named++
        }
      }
    }
    return {
      stressed: stressed.length,
      dialogs: dialogs.length,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: vw,
      pageOverflow,
      dialogIssues,
      offenders,
    }
  }, text)
}

/** One line per offender for a failure message. */
export function formatOffenders(r: StressReport): string {
  return [...r.dialogIssues, ...r.offenders.map((o) => `${o.leaf}: ${o.chain.join(' <- ')}`)].join('\n  ') || '(none named)'
}

/** Waits for finite animations only: an infinite one (animate-pulse, a spinner) never finishes. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
}
