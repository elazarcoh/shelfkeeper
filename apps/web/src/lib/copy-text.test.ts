import { describe, expect, it, vi } from 'vitest'
import { copyText } from './copy-text'

describe('copyText', () => {
  it('uses the Clipboard API on a secure page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    expect(await copyText('x', null, { clipboard: { writeText }, secure: true, execCopy: () => false })).toBe(true)
    expect(writeText).toHaveBeenCalledWith('x')
  })
  it('falls back to selecting the textarea and execCommand on plain http', async () => {
    const area = { value: '', focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() } as unknown as HTMLTextAreaElement
    expect(await copyText('prompt', area, { secure: false, execCopy: () => true })).toBe(true)
    expect(area.value).toBe('prompt')
  })
  it('reports failure when nothing works', async () => {
    expect(await copyText('x', null, { secure: false, execCopy: () => false })).toBe(false)
  })
})
