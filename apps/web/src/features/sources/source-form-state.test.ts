import { describe, expect, it } from 'vitest'
import { emptySourceForm, parseLibraryIds, sourceFormFrom, toCreateInput, toUpdatePatch } from './source-form-state'

describe('source form state', () => {
  it('parses comma-separated library ids, blank meaning all', () => {
    expect(parseLibraryIds(' a, b ,,')).toEqual(['a', 'b'])
    expect(parseLibraryIds('  ')).toBeNull()
  })

  it('builds an Audiobookshelf create input and names the failing field', () => {
    const form = { ...emptySourceForm('audiobookshelf'), name: 'Home ABS', baseUrl: 'http://abs.lan/', secret: 'tok' }
    expect(toCreateInput(form)).toEqual({
      ok: true,
      value: { name: 'Home ABS', schedule: null, config: { kind: 'audiobookshelf', baseUrl: 'http://abs.lan', apiToken: 'tok', libraryIds: null } },
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(toCreateInput({ ...form, secret: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/^API token/) })
  })

  it('builds Calibre inputs: optional login, blank password keeps the stored one, no username clears it', () => {
    const form = { ...emptySourceForm('calibre'), name: 'Calibre', baseUrl: 'http://calibre.lan:8080', username: 'me', secret: 'pw', wordCountColumn: '#words' }
    expect(toCreateInput(form)).toMatchObject({ ok: true, value: { config: { kind: 'calibre', username: 'me', password: 'pw', libraryId: null, wordCountColumn: '#words' } } })
    expect(toCreateInput({ ...form, username: '', secret: '' })).toMatchObject({ ok: true, value: { config: { username: null, password: null } } })
    const keep = toUpdatePatch({ ...form, secret: '', hasSecret: true })
    expect(keep.ok && keep.value.config && 'password' in keep.value.config ? keep.value.config.password : 'absent').toBe('absent')
    expect(toUpdatePatch({ ...form, username: '', secret: '' })).toMatchObject({ ok: true, value: { config: { username: null, password: null } } })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(toCreateInput({ ...form, wordCountColumn: 'words' })).toMatchObject({ ok: false, message: expect.stringMatching(/^Word count column/) })
  })

  it('refuses a Calibre username without a password, unless a stored one is kept', () => {
    const form = { ...emptySourceForm('calibre'), name: 'Calibre', baseUrl: 'http://calibre.lan:8080', username: 'me', secret: '' }
    expect(toCreateInput(form)).toEqual({ ok: false, message: 'Calibre needs both a username and a password' })
    expect(toUpdatePatch(form)).toEqual({ ok: false, message: 'Calibre needs both a username and a password' })
    expect(toUpdatePatch({ ...form, hasSecret: true })).toMatchObject({ ok: true })
    expect(toUpdatePatch({ ...form, hasSecret: true, secret: 'pw' })).toMatchObject({ ok: true, value: { config: { password: 'pw' } } })
  })

  it('builds Readarr and Chaptarr inputs with an API key', () => {
    const form = { ...emptySourceForm('chaptarr'), name: 'Chaptarr', baseUrl: 'http://chaptarr:8789', secret: 'k' }
    expect(toCreateInput(form)).toMatchObject({ ok: true, value: { config: { kind: 'chaptarr', apiKey: 'k' } } })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(toCreateInput({ ...form, secret: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/^API key/) })
  })

  it('round-trips a listed source into the edit form without its secret', () => {
    const form = sourceFormFrom({
      name: 'Calibre',
      schedule: 'daily',
      config: { kind: 'calibre', baseUrl: 'http://c', username: 'me', libraryId: 'Books', wordCountColumn: null, hasSecret: true },
    })
    expect(form).toMatchObject({ kind: 'calibre', name: 'Calibre', baseUrl: 'http://c', username: 'me', libraryId: 'Books', wordCountColumn: '', secret: '', schedule: 'daily', hasSecret: true })
  })
})
