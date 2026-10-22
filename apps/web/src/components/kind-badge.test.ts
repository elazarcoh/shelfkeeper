import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkKind } from '@mylib/domain'
import { KindBadge } from './kind-badge'

const render = (kind: WorkKind, compact = false) => renderToStaticMarkup(createElement(KindBadge, { kind, compact }))

describe('KindBadge', () => {
  it('shows a label for fanfiction and web serials, nothing for a book', () => {
    expect(render('fanfiction')).toContain('Fanfiction')
    expect(render('book')).toBe('')
  })
  it('renders nothing for a kind a newer server sent', () => {
    // a cached client must not crash on a kind it does not know
    expect(render('comic' as WorkKind)).toBe('')
    expect(render('comic' as WorkKind, true)).toBe('')
  })
})
