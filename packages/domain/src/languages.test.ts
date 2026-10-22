import { describe, expect, it } from 'vitest'
import { normalizeLanguage, scriptLanguage } from './languages'

describe('languages', () => {
  it.each([['English', 'en'], ['eng', 'en'], ['en-US', 'en'], [' EN ', 'en'], ['Hebrew', 'he'], ['heb', 'he'], ['iw', 'he'], ['עברית', 'he'], ['he-IL', 'he'], ['Klingon', 'Klingon'], ['', null], ['  ', null], [null, null]])('normalizeLanguage(%j) = %j', (raw, want) => expect(normalizeLanguage(raw)).toBe(want))

  it('scriptLanguage', () => {
    expect(scriptLanguage('קצב המלחמה')).toBe('he')
    expect(scriptLanguage('Rhythm of War')).toBe('en')
    expect(scriptLanguage('הארי Potter')).toBe('he')
    expect(scriptLanguage('1984')).toBeNull()
  })
})
