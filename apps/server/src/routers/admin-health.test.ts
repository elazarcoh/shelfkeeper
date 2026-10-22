import { describe, expect, it } from 'vitest'
import { series } from '@mylib/db'
import { useServerHarness } from '../testing/harness'

const TODAY = '2026-10-18'

describe('admin health router', () => {
  const h = useServerHarness()

  it('counts, lists, ignores and unignores a book with no ISBN', async () => {
    const admin = await h.asNewUser('admin')
    const { workId } = await admin.api.catalog.create({ work: { title: 'No Number', authors: ['Someone'], editions: [{ format: 'physical' }] } })
    expect((await admin.api.admin.health.counts({ today: TODAY })).no_isbn).toBe(1)
    expect(await admin.api.admin.health.list({ check: 'no_isbn', today: TODAY })).toEqual({ items: [{ check: 'no_isbn', key: workId, work: { id: workId, title: 'No Number' } }], more: false })
    await admin.api.admin.health.ignore({ check: 'no_isbn', subjectKey: workId })
    expect((await admin.api.admin.health.counts({ today: TODAY })).no_isbn).toBe(0)
    expect((await admin.api.admin.health.list({ check: 'no_isbn', today: TODAY, showIgnored: true })).items).toHaveLength(1)
    await admin.api.admin.health.unignore({ check: 'no_isbn', subjectKey: workId })
    expect((await admin.api.admin.health.counts({ today: TODAY })).no_isbn).toBe(1)
  })

  it('deletes an empty series and refuses one that has a book', async () => {
    const admin = await h.asNewUser('admin')
    await admin.api.catalog.create({ work: { title: 'Busy One', authors: ['Someone'], series: [{ name: 'Busy', position: 1 }], editions: [{ format: 'physical' }] } })
    const [lonely] = await h.db.insert(series).values({ name: 'Lonely', normalizedName: 'lonely' }).returning()
    const busy = (await h.db.select().from(series)).find((s) => s.normalizedName === 'busy')
    await expect(admin.api.admin.health.deleteEmptySeries({ seriesId: busy?.id ?? '' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await admin.api.admin.health.deleteEmptySeries({ seriesId: lonely?.id ?? '' })
    expect((await admin.api.admin.health.list({ check: 'empty_series', today: TODAY })).items).toEqual([])
  })

  it('dismisses a kind suggestion; a member marks a whole series', async () => {
    const admin = await h.asNewUser('admin')
    const { workId } = await admin.api.catalog.create({ work: { title: 'Losing Hogwarts', authors: ['Fan'], series: [{ name: 'Hog', position: 1 }], editions: [{ format: 'ebook' }] } })
    expect((await admin.api.admin.health.list({ check: 'kind_suggestions', today: TODAY })).items).toMatchObject([{ key: workId, suggested: 'fanfiction' }])
    await admin.api.admin.health.dismissKind({ workId })
    expect((await admin.api.admin.health.counts({ today: TODAY })).kind_suggestions).toBe(0)
    const member = await h.asNewUser()
    const seriesId = (await h.db.select().from(series)).find((s) => s.normalizedName === 'hog')?.id ?? ''
    expect(await member.api.catalog.setSeriesKind({ seriesId, kind: 'web_serial' })).toEqual({ changed: 1 })
    expect((await member.api.catalog.get({ workId })).kind).toBe('web_serial')
  })

  it('is admin-only', async () => {
    const member = await h.asNewUser()
    await expect(member.api.admin.health.counts({ today: TODAY })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.health.list({ check: 'no_cover', today: TODAY })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.health.ignore({ check: 'no_cover', subjectKey: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.health.dismissKind({ workId: '00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.health.deleteEmptySeries({ seriesId: '00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
