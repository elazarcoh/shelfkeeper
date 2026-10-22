import { describe, expect, it, vi } from 'vitest'
import translated from './fixtures/simania-translated-series.json'
import { bookmarkletSource, bookmarkletUrl } from './bookmarklet'

function fakePage(ld: unknown[], opener: { postMessage: ReturnType<typeof vi.fn>; closed: boolean } | null) {
  const inserted: string[] = []
  const location = { href: translated.url, origin: 'https://simania.co.il' }
  const document = {
    title: translated.title,
    querySelectorAll: (sel: string) =>
      sel.includes('ld+json')
        ? ld.map((n) => ({ textContent: JSON.stringify(n) }))
        : Object.entries(translated.meta).map(([k, v]) => ({ getAttribute: (a: string) => (a === 'property' ? k : null), content: v })),
    body: { insertAdjacentHTML: (_: string, html: string) => inserted.push(html) },
  }
  const listeners: ((e: { origin: string; data: unknown }) => void)[] = []
  const window = { opener, close: vi.fn(), addEventListener: (_: string, f: (e: { origin: string; data: unknown }) => void) => listeners.push(f) }
  // timers wait until `flush`, so the app's answer can arrive first
  const timers: (() => void)[] = []
  const setTimeout = (f: () => void) => timers.push(f)
  const flush = () => timers.splice(0).forEach((f) => f())
  const ack = (origin: string, data: unknown = { type: 'my-library/ack' }) => listeners.forEach((f) => f({ origin, data }))
  return { location, document, window, inserted, setTimeout, flush, ack }
}

// The bookmarklet is plain JS text: compiling it is the point of these tests.
/* eslint-disable @typescript-eslint/no-implied-eval */
const compile = (src: string) => new Function('window', 'document', 'location', 'setTimeout', src) as (...args: unknown[]) => void
const run = (src: string, p: ReturnType<typeof fakePage>) => compile(src)(p.window, p.document, p.location, p.setTimeout)

describe('bookmarklet', () => {
  const appUrl = 'http://192.168.1.174:8080/books/shelf'
  it('posts the capture to the app tab and closes once the app confirms', () => {
    const opener = { postMessage: vi.fn(), closed: false }
    const p = fakePage(translated.ld, opener)
    run(bookmarkletSource(appUrl), p)
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'my-library/capture', v: 1, capture: expect.objectContaining({ url: translated.url }) as unknown }, 'http://192.168.1.174:8080')
    expect(p.window.close).not.toHaveBeenCalled()
    p.ack('http://192.168.1.174:8080')
    p.flush()
    expect(p.window.close).toHaveBeenCalled()
    expect(p.inserted.join('')).toContain('Sent to My Library')
    expect(p.location.href).toBe(translated.url)
  })
  it('without a confirmation from the app, falls back to the hash and does not close', () => {
    const p = fakePage(translated.ld, { postMessage: vi.fn(), closed: false })
    run(bookmarkletSource(appUrl), p)
    p.ack('https://evil.example')
    p.ack('http://192.168.1.174:8080', { type: 'other' })
    p.flush()
    expect(p.window.close).not.toHaveBeenCalled()
    expect(p.location.href.startsWith(`${appUrl}#capture=`)).toBe(true)
  })
  it('without an app tab, opens the app with the capture in the hash', () => {
    const p = fakePage(translated.ld, null)
    run(bookmarkletSource(appUrl), p)
    expect(p.location.href.startsWith(`${appUrl}#capture=`)).toBe(true)
  })
  it('on a page with no book shows a banner and sends nothing', () => {
    const opener = { postMessage: vi.fn(), closed: false }
    const p = fakePage([{ '@type': 'Person', name: 'x' }], opener)
    run(bookmarkletSource(appUrl), p)
    expect(opener.postMessage).not.toHaveBeenCalled()
    expect(p.inserted.join('')).toContain('Not a book page')
  })
  it('is a single javascript: URL', () => {
    const url = bookmarkletUrl(appUrl)
    expect(url.startsWith('javascript:')).toBe(true)
    expect(() => new Function(decodeURIComponent(url.slice('javascript:'.length)))).not.toThrow()
    /* eslint-enable @typescript-eslint/no-implied-eval */
  })
})
