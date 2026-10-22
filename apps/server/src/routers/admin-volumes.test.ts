import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string) => ({ title, authors: ['Someone'], editions: [{ format: 'physical' as const }] })

describe('admin volumes router', () => {
  const h = useServerHarness()

  it('lets an admin list the catalog and merge two works as volumes', async () => {
    const admin = await h.asNewUser('admin')
    const a = (await admin.api.catalog.create({ work: book('Saga, volume 1') })).workId
    const b = (await admin.api.catalog.create({ work: book('Saga, volume 2') })).workId
    const catalog = await admin.api.admin.volumes.catalog()
    expect(catalog.map((e) => e.id).sort()).toEqual([a, b].sort())
    const result = await admin.api.admin.volumes.merge({
      survivorId: a,
      title: 'Saga',
      members: [
        { workId: a, volume: 1 },
        { workId: b, volume: 2 },
      ],
      volumeCount: 2,
    })
    expect(result.workId).toBe(a)
    // the members' differing titles are expected in a volume merge, so they are not reported as dropped
    expect(result.dropped).toEqual([])
    expect((await admin.api.admin.volumes.catalog()).map((e) => e.id)).toEqual([a])
  })

  it('refuses members and a count below a volume', async () => {
    const member = await h.asNewUser()
    const id = '00000000-0000-4000-8000-000000000001'
    const other = '00000000-0000-4000-8000-000000000002'
    const input = { survivorId: id, title: 'X', members: [{ workId: id, volume: 1 }, { workId: other, volume: 2 }], volumeCount: 2 }
    await expect(member.api.admin.volumes.catalog()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.volumes.merge(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const admin = await h.asNewUser('admin')
    await expect(admin.api.admin.volumes.merge({ ...input, volumeCount: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
