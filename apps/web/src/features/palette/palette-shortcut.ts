type Keys = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

/** Ctrl-K / ⌘-K by the physical key: with a Hebrew layout `key` is "ל". Ctrl+Alt is AltGr on Windows, not a shortcut. */
export function isPaletteShortcut(e: Keys): boolean {
  return e.code === 'KeyK' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
}

/** The shortcut never opens the palette over another dialog (two focus traps), but always closes it. */
export function shouldTogglePalette(paletteOpen: boolean, otherDialogOpen: boolean): boolean {
  return paletteOpen || !otherDialogOpen
}
