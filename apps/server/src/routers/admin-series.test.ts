import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string, series: string) => ({ title, authors: ['A. Author'], series: [{ name: series, position: 1 }], editions: [{ format: 'physical' as const }] })

describe('admin series router', () => {
  const h = useServerHarness()

  it('lets an admin list, add a name to, and merge series', async () => {
    const admin = await h.asNewUser('admin')
    await admin.api.catalog.create({ work: book('One', 'The Stormlight Archive') })
    await admin.api.catalog.create({ work: book('Two', 'ארכיון האור') })
    const en = (await admin.api.admin.series.list({ q: 'stormlight' })).series[0]
    const he = (await admin.api.admin.series.list({ q: 'ארכיון' })).series[0]
    if (!en || !he) throw new Error('seed failed')
    await expect(admin.api.admin.series.addName({ seriesId: en.id, name: 'ארכיון האור' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const { seriesId } = await admin.api.admin.series.merge({ seriesId: he.id, otherId: en.id, primaryNameId: en.names[0]?.id ?? '' })
    const detail = await admin.api.admin.series.get({ seriesId })
    expect(detail.names.map((n) => n.name)).toEqual(['The Stormlight Archive', 'ארכיון האור'])
    expect(detail.books).toHaveLength(2)
  })

  it('is admin-only', async () => {
    const member = await h.asNewUser()
    const id = '00000000-0000-4000-8000-000000000001'
    const other = '00000000-0000-4000-8000-000000000002'
    await expect(member.api.admin.series.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.series.get({ seriesId: id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.series.merge({ seriesId: id, otherId: other, primaryNameId: id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.series.split({ nameId: id, workIds: [other] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
