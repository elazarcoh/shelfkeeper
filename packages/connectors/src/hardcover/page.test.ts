import type { HardcoverBookPage } from '@mylib/domain'
import { describe, expect, it } from 'vitest'
import { hardcoverPage } from './page'

const edition = (id: number, extra: Partial<HardcoverBookPage['editions'][number]> = {}): HardcoverBookPage['editions'][number] => ({
  id,
  title: null,
  format: null,
  pages: null,
  publisher: null,
  releaseDate: null,
  isbn13: null,
  isbn10: null,
  imageUrl: null,
  language: null,
  ...extra,
})
const worm: HardcoverBookPage = {
  id: 474572,
  slug: 'worm',
  title: 'Worm',
  description: 'A web serial.',
  releaseDate: '2013-11-19',
  imageUrl: 'https://assets.hardcover.app/book.jpeg',
  authors: ['Wildbow'],
  translators: [],
  series: { name: 'Parahumans', position: 1 },
  mainEditionId: 30647610,
  editions: [
    edition(30647610, { pages: 6073, publisher: 'Parahumans.wordpress.com', format: 'Webnovel', language: 'en', releaseDate: '2013-11-19', imageUrl: 'https://assets.hardcover.app/ed.jpeg' }),
    edition(30647611, { pages: 4192, format: 'E-book' }),
    edition(30647612),
  ],
}

describe('hardcoverPage', () => {
  it('reads the main edition when none is chosen', () => {
    expect(hardcoverPage(worm, null)).toMatchObject({
      provider: 'hardcover',
      providerId: '474572',
      url: 'https://hardcover.app/books/worm/editions/30647610',
      pageCount: 6073,
      publisher: 'Parahumans.wordpress.com',
      publishedOn: '2013-11-19',
      year: '2013',
      language: 'en',
      series: { name: 'Parahumans', position: 1 },
      isbn13: null,
      coverUrl: 'https://assets.hardcover.app/ed.jpeg',
      volume: null,
      importedTitle: null,
    })
  })

  it('reads the chosen edition', () => {
    expect(hardcoverPage(worm, 30647611).pageCount).toBe(4192)
  })

  it('falls back to the book without editions', () => {
    const page = hardcoverPage({ ...worm, editions: [] }, null)
    expect(page).toMatchObject({ pageCount: null, publisher: null, coverUrl: worm.imageUrl, description: worm.description, url: 'https://hardcover.app/books/worm' })
  })

  it('keeps only a full date', () => {
    const page = hardcoverPage({ ...worm, releaseDate: '2013', editions: [] }, null)
    expect(page.publishedOn).toBeNull()
    expect(page.year).toBeNull()
  })
})
