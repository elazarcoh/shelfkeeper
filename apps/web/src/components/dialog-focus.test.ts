import { describe, expect, it } from 'vitest'
import { openFocusTarget, returnFocusProps } from './dialog-focus'

describe('returnFocusProps', () => {
  it('adds nothing without a ref, so Radix keeps returning focus to its own trigger', () => {
    expect(returnFocusProps(undefined)).toEqual({})
  })

  it('replaces the close focus with the ref, read when the dialog closes', () => {
    const focused: string[] = []
    const ref: { current: { focus: () => void } | null } = { current: null }
    const { onCloseAutoFocus } = returnFocusProps(ref)
    ref.current = { focus: () => focused.push('menu button') }
    let prevented = false
    onCloseAutoFocus?.({ preventDefault: () => (prevented = true) } as never)
    expect(prevented).toBe(true)
    expect(focused).toEqual(['menu button'])
  })

  it('still prevents the default when the ref target is gone', () => {
    let prevented = false
    returnFocusProps({ current: null }).onCloseAutoFocus?.({ preventDefault: () => (prevented = true) } as never)
    expect(prevented).toBe(true)
  })
})

describe('openFocusTarget', () => {
  it('always starts on the title on a touch screen, so no keyboard pops up over the sheet', () => {
    expect(openFocusTarget(true)).toBe('title')
  })

  it('keeps the default first-control focus with a mouse or keyboard', () => {
    expect(openFocusTarget(false)).toBe('default')
  })
})
