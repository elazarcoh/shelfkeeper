import { describe, expect, it } from 'vitest'
import { ExternalItem, withVolumeOverride } from '../sources'
import original from './fixtures/simania-original-hebrew.json'
import translated from './fixtures/simania-translated-series.json'
import seriesNumber from './fixtures/simania-series-number-title.json'
import brackets from './fixtures/simania-edition-brackets.json'
import yearParens from './fixtures/simania-year-parens.json'
import translatorPrefix from './fixtures/simania-translator-prefix.json'
import isbnPrefix from './fixtures/simania-isbn-prefix-only.json'
import authorPage from './fixtures/simania-author-page.json'
import { captureFromHtml, defaultSourceFor, extractPage, isAllowedCoverRedirect, isAllowedCoverUrl, sourceLabel, isBookCapture, mergeLinkedPage, pageFromText, PageCapture, providerForOrigin, providerForUrl } from '.'

const page = (c: unknown) => {
  const r = extractPage(PageCapture.parse(c))
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('Simania pages', () => {
  it('an original Hebrew book', () => {
    expect(page(original)).toMatchObject({ providerId: '4373', title: 'מסע אל תום האלף', authors: ['אברהם ב. יהושע'], translators: [], publisher: 'הקיבוץ המאוחד', year: '1997', pageCount: 318, isbn13: null, isbn10: null, coverUrl: 'https://cdn.simania.co.il/bookimages/covers0/4373.jpg' })
  })
  it('a translated book in a series', () => {
    expect(page(translated)).toMatchObject({ title: 'רסיסים של אור א', translators: ['צפריר גרוסמן'], series: { name: 'גנזך אורות הסער', position: null } })
  })
  it('strips "<series> #n - " from the title and keeps n as the position', () => {
    expect(page(seriesNumber)).toMatchObject({ title: 'צופן הנצח', series: { name: 'ארטמיס פאול', position: 3 } })
  })
  it('strips an edition note in brackets and a year in parentheses', () => {
    expect(page(brackets).title).toBe('הנסיכה הקסומה')
    expect(page(yearParens).title).toBe('המזימה של אופאל')
  })
  it('strips "<series> - " and a language prefix on the translator; drops an invalid ISBN', () => {
    expect(page(translatorPrefix)).toMatchObject({ title: 'המושבה האבודה', translators: ['עפרה אביגד'], isbn13: null, isbn10: null })
    expect(page(isbnPrefix)).toMatchObject({ title: 'הקמיע מסמרקנד', isbn13: null, isbn10: null })
  })
  it('refuses an author page, and a page whose data is for another book', () => {
    expect(extractPage(PageCapture.parse(authorPage))).toEqual({ ok: false, error: 'not_a_book_page' })
    const stale = { ...translated, url: 'https://simania.co.il/bookdetails.php?item_id=4373' }
    expect(extractPage(PageCapture.parse(stale))).toEqual({ ok: false, error: 'stale' })
    expect(extractPage(PageCapture.parse({ ...translated, url: 'https://example.com/x' }))).toEqual({ ok: false, error: 'unknown_page' })
  })
  it("isBookCapture: the bookmarklet's own check", () => {
    expect(isBookCapture(PageCapture.parse(translated))).toBe(true)
    expect(isBookCapture(PageCapture.parse(authorPage))).toBe(false)
  })
})

describe('urls', () => {
  it('finds the provider and id in pasted text, www or not; nothing else', () => {
    expect(pageFromText('look: https://www.simania.co.il/bookdetails.php?item_id=43129&x=1 thanks')).toMatchObject({ id: '43129' })
    expect(pageFromText('https://simania.co.il/authorDetails.php?itemId=1')).toBeNull()
    expect(pageFromText('https://evil.example/bookdetails.php?item_id=1')).toBeNull()
    expect(pageFromText('no link')).toBeNull()
    expect(providerForUrl('https://simania.co.il/bookdetails.php?item_id=12')?.provider.canonicalUrl('12')).toBe('https://simania.co.il/bookdetails.php?item_id=12')
  })
  it('accepts messages only from https provider origins', () => {
    expect(providerForOrigin('https://simania.co.il')?.id).toBe('simania')
    expect(providerForOrigin('https://www.simania.co.il')?.id).toBe('simania')
    expect(providerForOrigin('http://simania.co.il')).toBeNull()
    expect(providerForOrigin('https://simania.co.il.evil.example')).toBeNull()
    expect(providerForOrigin('https://simania.co.il:8443')).toBeNull()
    expect(providerForUrl('https://simania.co.il:444/bookdetails.php?item_id=1')).toBeNull()
  })
  it('allows covers only from the provider image host over https', () => {
    expect(isAllowedCoverUrl('https://cdn.simania.co.il/bookimages/covers0/4373.jpg')).toBe(true)
    expect(isAllowedCoverUrl('http://cdn.simania.co.il/a.jpg')).toBe(false)
    expect(isAllowedCoverUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isAllowedCoverUrl('https://cdn.simania.co.il:8080/x')).toBe(false)
    expect(isAllowedCoverUrl('https://user@cdn.simania.co.il/x')).toBe(false)
    expect(isAllowedCoverUrl('https://cdn.simania.co.il./x')).toBe(false)
  })
})

describe('captureFromHtml', () => {
  it('reads JSON-LD and meta like the bookmarklet, stripping reviews and offers', () => {
    const html = `<html><head><title>T</title><meta property="og:image" content="https://cdn.simania.co.il/a.jpg"><script type="application/ld+json">{"@type":"Book","name":"א","offers":[1],"review":[2],"description":"${'x'.repeat(3000)}"}</script></head></html>`
    const c = captureFromHtml(html, 'https://simania.co.il/bookdetails.php?item_id=1')
    expect(c.title).toBe('T')
    expect(c.meta['og:image']).toBe('https://cdn.simania.co.il/a.jpg')
    expect(c.ld[0]).toEqual({ '@type': 'Book', name: 'א', description: 'x'.repeat(2000) })
  })
})

describe('mergeLinkedPage', () => {
  it('the page wins, the AI keeps the series position, an invalid ISBN never lands', () => {
    const item = ExternalItem.parse({ externalId: 'photo:4', format: 'physical', title: 'ארטימס פאול - המושדה האבודה', authors: ['אואן קולפר'], series: [{ name: 'ארטמיס פאול', position: 7 }] })
    const before = JSON.stringify(item)
    const merged = mergeLinkedPage(item, page(translatorPrefix))
    expect(JSON.stringify(item)).toBe(before)
    expect(merged).toMatchObject({
      externalId: 'photo:4', title: 'המושבה האבודה', translators: ['עפרה אביגד'], publisher: 'כנרת', pageCount: 362,
      series: [{ name: 'ארטמיס פאול', position: 7 }], identifiers: { isbn13: null, isbn10: null, others: { simania: '690482' } },
      coverUrl: expect.stringContaining('cdn.simania.co.il') as string,
    })
  })
  it('an explicit "#n" on the page wins; the AI number only counts for the same series', () => {
    const ai = (series: { name: string; position: number }[]) => ExternalItem.parse({ externalId: 'photo:5', format: 'physical', title: 'x', authors: [], series })
    expect(mergeLinkedPage(ai([{ name: 'ארטמיס פאול', position: 7 }]), page(seriesNumber)).series).toEqual([{ name: 'ארטמיס פאול', position: 3, positionEnd: null }])
    expect(mergeLinkedPage(ai([{ name: 'ארטמיס פאול', position: 7 }]), page(translatorPrefix)).series).toEqual([{ name: 'ארטמיס פאול', position: 7, positionEnd: null }])
    expect(mergeLinkedPage(ai([{ name: 'סדרה אחרת', position: 2 }]), page(translatorPrefix)).series).toEqual([{ name: 'ארטמיס פאול', position: null, positionEnd: null }])
  })
})

const simaniaCaptureWithTitle = (name: string) => {
  const copy = structuredClone(translated) as { ld: Record<string, unknown>[] }
  const book = copy.ld.find((n) => n['@type'] === 'Book')
  if (book === undefined) throw new Error('no Book node')
  book['name'] = name
  return copy
}

describe('volumes on book pages', () => {
  it('a page whose title ends in a volume marker gives the cleaned title and the volume', () => {
    const extracted = page(simaniaCaptureWithTitle("ג'ונתן סטריינג' ומר נורל - כרך ב'"))
    expect({ title: extracted.title, volume: extracted.volume }).toEqual({ title: "ג'ונתן סטריינג' ומר נורל", volume: { number: 2, count: null } })
  })
  it('the page title as printed is kept, and "not a volume" gets it back after a merge', () => {
    const extracted = page(simaniaCaptureWithTitle("ספר - כרך ב'"))
    expect(extracted.importedTitle).toBe("ספר - כרך ב'")
    const item = ExternalItem.parse({ externalId: 'x', format: 'physical', title: 'T' })
    const merged = mergeLinkedPage(item, extracted)
    expect(merged).toMatchObject({ title: 'ספר', volume: { number: 2, count: null } })
    expect(withVolumeOverride(merged, null)).toMatchObject({ title: "ספר - כרך ב'", volume: null })
    expect(page(translated).importedTitle ?? null).toBeNull()
  })
  it('mergeLinkedPage keeps the page volume, else the item volume', () => {
    const item = ExternalItem.parse({ externalId: 'x', format: 'physical', title: 'T' })
    const p = page(translated)
    expect(mergeLinkedPage({ ...item, volume: { number: 1, count: null } }, { ...p, volume: null }).volume).toEqual({ number: 1, count: null })
    expect(mergeLinkedPage({ ...item, volume: { number: 1, count: null } }, { ...p, volume: { number: 2, count: 2 } }).volume).toEqual({ number: 2, count: 2 })
  })
})

describe('Hardcover as a metadata source', () => {
  it('labels and defaults', () => {
    expect(sourceLabel('hardcover')).toBe('Hardcover')
    expect(sourceLabel('simania')).toBe('Simania')
    expect(sourceLabel('openlibrary')).toBe('Open Library')
    expect(defaultSourceFor({ language: null, title: 'Worm' }, true)).toBe('hardcover')
    expect(defaultSourceFor({ language: null, title: 'Worm' }, false)).toBe('openlibrary')
    expect(defaultSourceFor({ language: 'he', title: 'תולעת' }, true)).toBe('simania')
  })

  it('accepts its cover host over https only, with no redirects off it', () => {
    expect(isAllowedCoverUrl('https://assets.hardcover.app/edition/30395760/x.jpeg')).toBe(true)
    expect(isAllowedCoverUrl('http://assets.hardcover.app/x.jpeg')).toBe(false)
    expect(isAllowedCoverRedirect('https://assets.hardcover.app/a.jpg', 'https://evil.example/a.jpg')).toBe(false)
  })
})
