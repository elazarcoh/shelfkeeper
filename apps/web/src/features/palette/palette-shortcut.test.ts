import { describe, expect, it } from 'vitest'
import { isPaletteShortcut, shouldTogglePalette } from './palette-shortcut'

const key = (over: Partial<Parameters<typeof isPaletteShortcut>[0]>) => ({ code: 'KeyK', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over })

describe('isPaletteShortcut', () => {
  it('is Ctrl-K or ⌘-K', () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isPaletteShortcut(key({ metaKey: true }))).toBe(true)
    expect(isPaletteShortcut(key({}))).toBe(false)
  })
  it('goes by the physical key, so a Hebrew layout (key "ל") still works', () => {
    expect(isPaletteShortcut({ ...key({ ctrlKey: true }), code: 'KeyK' })).toBe(true)
    expect(isPaletteShortcut(key({ ctrlKey: true, code: 'KeyL' }))).toBe(false)
  })
  it('ignores AltGr (Ctrl+Alt) and Shift', () => {
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
  })
})

describe('shouldTogglePalette', () => {
  it('opens when nothing else is open and always closes an open palette', () => {
    expect(shouldTogglePalette(false, false)).toBe(true)
    expect(shouldTogglePalette(true, false)).toBe(true)
    expect(shouldTogglePalette(true, true)).toBe(true)
  })
  it('does not open over another dialog', () => {
    expect(shouldTogglePalette(false, true)).toBe(false)
  })
})
