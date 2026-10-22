const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function isValidCodePoint(cp: number): boolean {
  return cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16)
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : whole
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10)
      return isValidCodePoint(cp) ? String.fromCodePoint(cp) : whole
    }
    return NAMED[entity.toLowerCase()] ?? whole
  })
}

/** Source descriptions (Audiobookshelf, Calibre "comments") are HTML; the catalog stores plain text. */
export function htmlToText(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null
  const text = decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
      .replace(/<\/?[a-z][^>]*>/gi, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text === '' ? null : text
}
