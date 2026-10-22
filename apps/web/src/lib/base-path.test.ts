import { describe, expect, it } from 'vitest'
import { joinBase, normalizeBase, routerBasepath, withBase } from './base-path'

describe('base path', () => {
  it('normalizes BASE_PATH to Vite\'s form: "/" or "/prefix/"', () => {
    expect(normalizeBase(undefined)).toBe('/')
    expect(normalizeBase('')).toBe('/')
    expect(normalizeBase('/')).toBe('/')
    expect(normalizeBase('/mylibrary')).toBe('/mylibrary/')
    expect(normalizeBase('mylibrary/')).toBe('/mylibrary/')
    expect(normalizeBase(' /apps/my-library/ ')).toBe('/apps/my-library/')
    for (const bad of ['//evil.example', '/a b', '/a?b', '/../x', 'http://x']) expect(() => normalizeBase(bad), bad).toThrow()
  })

  it('prefixes a root-absolute path with the base', () => {
    expect(joinBase('/', '/trpc')).toBe('/trpc')
    expect(joinBase('/', '/media/abc')).toBe('/media/abc')
    expect(joinBase('/mylibrary/', '/trpc')).toBe('/mylibrary/trpc')
    expect(joinBase('/mylibrary/', '/maintenance?next=%2F')).toBe('/mylibrary/maintenance?next=%2F')
    expect(joinBase('/mylibrary/', '/')).toBe('/mylibrary/')
  })

  it('gives the router its basepath without the trailing slash', () => {
    expect(routerBasepath('/')).toBe('/')
    expect(routerBasepath('/mylibrary/')).toBe('/mylibrary')
  })

  it('uses the build\'s base (the root in tests), so nothing changes without BASE_PATH', () => {
    expect(withBase('/trpc')).toBe('/trpc')
  })
})
