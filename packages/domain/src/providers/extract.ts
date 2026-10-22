import { cleanIsbn, isValidIsbn10, isValidIsbn13 } from '../isbn'
import type { PageCapture } from './page-capture'

export type BookNode = Record<string, unknown>

const types = (n: BookNode): string[] => [n['@type']].flat().filter((t): t is string => typeof t === 'string')

export function bookNode(capture: Pick<PageCapture, 'ld'>): BookNode | null {
  const all: BookNode[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object') {
      all.push(v as BookNode)
      walk((v as BookNode)['@graph'])
    }
  }
  walk(capture.ld)
  return all.find((n) => types(n).some((t) => t === 'Book')) ?? null
}

export const clean = (s: unknown): string | null => (typeof s === 'string' && s.replace(/\s+/g, ' ').trim() !== '' ? s.replace(/\s+/g, ' ').trim() : null)

export function names(v: unknown): string[] {
  return [v].flat().flatMap((x) => {
    const name = typeof x === 'string' ? x : x !== null && typeof x === 'object' ? (x as BookNode)['name'] : null
    const c = clean(name)
    return c === null ? [] : [c]
  })
}

export function validIsbns(...candidates: unknown[]): { isbn13: string | null; isbn10: string | null } {
  let isbn13: string | null = null
  let isbn10: string | null = null
  for (const c of candidates) {
    if (typeof c !== 'string') continue
    const v = cleanIsbn(c)
    if (isbn13 === null && isValidIsbn13(v)) isbn13 = v
    if (isbn10 === null && isValidIsbn10(v)) isbn10 = v
  }
  return { isbn13, isbn10 }
}

export function imageUrl(v: unknown): string | null {
  const first = [v].flat()[0]
  return clean(typeof first === 'string' ? first : first !== null && typeof first === 'object' ? (first as BookNode)['url'] : null)
}
