import { describe, expect, it } from 'vitest'
import { searchOffline, type OfflineWork } from './offline'

const work = (id: string, title: string, more: Partial<OfflineWork> = {}): OfflineWork => ({
  id,
  title,
  subtitle: null,
  kind: 'book',
  authors: [],
  series: null,
  formats: ['physical'],
  availability: 'owned',
  status: 'none',
  rating: null,
  coverAssetId: null,
  ...more,
})

const works = [
  work('1', 'The Wandering Inn', { authors: ['pirateaba'] }),
  work('2', 'A Game of Thrones', { authors: ['George R. R. Martin'], series: { name: 'A Song of Ice and Fire', position: 1, positionEnd: null } }),
  work('3', 'הנסיך הקטן', { authors: ['אנטואן דה סנט-אכזופרי'] }),
  work('4', 'Inn Stories', { authors: ['Wanda Inn'] }),
]
const ids = (q: string) => searchOffline(works, q).map((w) => w.id)

describe('searchOffline', () => {
  it('lists nothing for an empty query', () => {
    expect(ids('  ')).toEqual([])
  })
  it('matches the start of words, in any order, ignoring case and accents', () => {
    expect(ids('wand inn')).toEqual(['1', '4'])
    expect(ids('GAME thr')).toEqual(['2'])
    expect(ids('הנסיך')).toEqual(['3'])
    expect(ids('ame')).toEqual([])
  })
  it('puts title hits before author and series hits', () => {
    expect(ids('inn')).toEqual(['1', '4'])
    expect(ids('martin')).toEqual(['2'])
    expect(ids('ice fire')).toEqual(['2'])
  })
  it('finds a book by its first-letter abbreviation', () => {
    expect(ids('twi')).toEqual(['1'])
    expect(ids('asoiaf')).toEqual(['2'])
  })
  it('stops at the limit', () => {
    expect(searchOffline(works, 'inn', 1).map((w) => w.id)).toEqual(['1'])
  })
})
