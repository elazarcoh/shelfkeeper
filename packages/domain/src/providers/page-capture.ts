import { z } from 'zod'

const STRIPPED = new Set(['review', 'reviews', 'offers', 'aggregateRating', 'brand'])
export const DESCRIPTION_MAX = 2000

export function stripLd(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLd)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, v]) => (STRIPPED.has(k) ? [] : [[k, k === 'description' && typeof v === 'string' ? v.slice(0, DESCRIPTION_MAX) : stripLd(v)]])),
    )
  }
  return value
}

export const PageCapture = z
  .object({
    url: z.string().max(2000),
    title: z.string().max(500).catch(''),
    ld: z.array(z.unknown()).max(20),
    meta: z.record(z.string().max(200), z.string().max(2000)).refine((m) => Object.keys(m).length <= 200, 'Too many meta tags'),
  })
  .refine((c) => JSON.stringify(c).length <= 256_000, 'Page capture too large')
export type PageCapture = z.output<typeof PageCapture>

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** What the bookmarklet would have sent, read from a fetched page (paste-link fallback, tests). */
export function captureFromHtml(html: string, url: string): PageCapture {
  const ld: unknown[] = []
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      if (ld.length < 20) ld.push(stripLd(JSON.parse(m[1] ?? '')))
    } catch {
      // a broken block is skipped, like the bookmarklet does
    }
  }
  const meta: Record<string, string> = {}
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...(m[1] ?? '').matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((a) => [(a[1] ?? '').toLowerCase(), a[2] ?? '']))
    const key = attrs['property'] ?? attrs['name']
    if (key !== undefined && attrs['content'] !== undefined && !(key in meta) && Object.keys(meta).length < 200) meta[key.slice(0, 200)] = decode(attrs['content']).slice(0, 2000)
  }
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '').slice(0, 500)
  return { url: url.slice(0, 2000), title, ld, meta }
}
