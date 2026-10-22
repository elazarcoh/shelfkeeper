import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Field, firstInvalidField } from './field'

const render = (control: Record<string, unknown>, note: { hint?: string; error?: string }) =>
  renderToString(createElement(Field, { label: 'Title', htmlFor: 't', ...note, children: createElement('input', { id: 't', ...control }) }))

describe('Field', () => {
  it('describes the control by its hint or error', () => {
    expect(render({}, { hint: 'One per line' })).toContain('aria-describedby="t-note"')
    expect(render({}, { error: 'Required' })).toMatch(/aria-invalid="true"[^>]*aria-describedby="t-note"/)
  })
  it('keeps the control’s own aria-describedby and adds the note to it', () => {
    expect(render({ 'aria-describedby': 'own-help' }, { error: 'Required' })).toContain('aria-describedby="own-help t-note"')
  })
  it('leaves the control’s own aria-describedby alone when there is no note', () => {
    expect(render({ 'aria-describedby': 'own-help' }, {})).toContain('aria-describedby="own-help"')
  })
})

describe('firstInvalidField', () => {
  it('is the first control Field marked invalid, in document order', () => {
    const control = { focus: () => undefined }
    const selectors: string[] = []
    const form = {
      querySelector: (selector: string) => {
        selectors.push(selector)
        return control
      },
    }
    expect(firstInvalidField(form as unknown as ParentNode)).toBe(control)
    expect(selectors).toEqual(['[aria-invalid="true"]'])
  })
  it('is null without a form', () => {
    expect(firstInvalidField(null)).toBeNull()
  })
})
