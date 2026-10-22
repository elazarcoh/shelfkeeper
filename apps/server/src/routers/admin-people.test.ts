import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string, author: string) => ({ title, authors: [author], editions: [{ format: 'physical' as const }] })

describe('admin people router', () => {
  const h = useServerHarness()

  it('lets an admin merge two spellings, see them as one person, and split one off again', async () => {
    const admin = await h.asNewUser('admin')
    await admin.api.catalog.create({ work: book('The Way of Kings', 'Brandon Sanderson') })
    await admin.api.catalog.create({ work: book('דרך המלכים', 'ברנדון סנדרסון') })
    const { people } = await admin.api.admin.people.list({ q: 'sanderson' })
    const en = people[0]
    const he = (await admin.api.admin.people.list({ q: 'סנדרסון' })).people[0]
    if (!en || !he) throw new Error('seed failed')
    const { personId } = await admin.api.admin.people.merge({ personId: he.id, otherId: en.id, primaryNameId: en.names[0]?.id ?? '' })
    const detail = await admin.api.admin.people.get({ personId })
    expect(detail.names.map((n) => n.name)).toEqual(['Brandon Sanderson', 'ברנדון סנדרסון'])
    expect(detail.bookCount).toBe(2)

    const facets = await admin.api.catalog.facets()
    expect(facets.authors.filter((a) => a.id === personId)).toEqual([{ id: personId, name: 'Brandon Sanderson', otherNames: ['ברנדון סנדרסון'] }])

    await admin.api.admin.people.splitOff({ nameId: detail.names[1]?.id ?? '' })
    expect((await admin.api.admin.people.list({ q: 'סנדרסון' })).people.map((p) => p.name)).toEqual(['ברנדון סנדרסון'])
  })

  it("answers a spelling that is taken with the friendly conflict", async () => {
    const admin = await h.asNewUser("admin")
    await admin.api.catalog.create({ work: book("One", "Brandon Sanderson") })
    await admin.api.catalog.create({ work: book("Two", "ברנדון סנדרסון") })
    const en = (await admin.api.admin.people.list({ q: "sanderson" })).people[0]
    await expect(admin.api.admin.people.addName({ personId: en?.id ?? "", name: "ברנדון סנדרסון" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That name is ברנדון סנדרסון’s — use Same person as… instead",
    })
  })

  it('is admin-only', async () => {
    const member = await h.asNewUser()
    const id = '00000000-0000-4000-8000-000000000001'
    await expect(member.api.admin.people.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.people.get({ personId: id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.people.merge({ personId: id, otherId: '00000000-0000-4000-8000-000000000002', primaryNameId: id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.people.delete({ personId: id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
