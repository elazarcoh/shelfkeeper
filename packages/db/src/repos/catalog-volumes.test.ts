import { describe, expect, it } from 'vitest'
import { seedUser, useTestDb, workInput } from '../testing'
import { addEdition, createWork, getWorkDetail, splitEdition, updateEdition } from './catalog'
import { loadUserScope } from './scope'
import { EditionInput } from '@mylib/domain'

describe('edition volumes', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  const vol = (volume: number, volumeCount: number | null, over: Partial<EditionInput> = {}) =>
    EditionInput.parse({ format: 'physical', language: 'he', volume, volumeCount, ...over })

  it('stores and returns volume fields, volumes in order', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(2, 2), vol(1, 2)] }))
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions.map((e) => [e.volume, e.volumeCount])).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('keeps volume_count equal across a set when one volume changes it', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2)] }))
    const second = await addEdition(t.db, scope, workId, vol(2, null))
    const english = await addEdition(t.db, scope, workId, EditionInput.parse({ format: 'physical', language: 'en' }))
    await updateEdition(t.db, scope, second, { volumeCount: 3 })
    const editions = (await getWorkDetail(t.db, scope, workId)).editions
    expect(editions.filter((e) => e.id !== english).map((e) => e.volumeCount)).toEqual([3, 3])
    expect(editions.find((e) => e.id === english)?.volumeCount).toBeNull()
  })

  it('a new volume with a count updates its siblings', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, null)] }))
    await addEdition(t.db, scope, workId, vol(2, 2))
    expect((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.volumeCount)).toEqual([2, 2])
  })

  it('does not sync across languages (null is its own language)', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2)] }))
    const noLanguage = await addEdition(t.db, scope, workId, vol(1, null, { language: null }))
    await updateEdition(t.db, scope, noLanguage, { volumeCount: 5 })
    const editions = (await getWorkDetail(t.db, scope, workId)).editions
    expect(editions.find((e) => e.id !== noLanguage)?.volumeCount).toBe(2)
  })

  it("a format change joins the new set and takes its count, leaving the old one", async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2)] }))
    const ebook1 = await addEdition(t.db, scope, workId, vol(1, 4, { format: 'ebook' }))
    const second = await addEdition(t.db, scope, workId, vol(2, 2))
    await updateEdition(t.db, scope, second, { format: 'ebook' })
    const editions = (await getWorkDetail(t.db, scope, workId)).editions
    expect(editions.find((e) => e.id === ebook1)?.volumeCount).toBe(4)
    expect(editions.find((e) => e.id === second)?.volumeCount).toBe(4)
    expect(editions.find((e) => e.id !== ebook1 && e.id !== second)?.volumeCount).toBe(2)
  })

  it('moving a volume to a language with no set drops its count', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2), vol(2, 2)] }))
    const second = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.volume === 2)
    await updateEdition(t.db, scope, second?.id ?? '', { language: 'en' })
    const editions = (await getWorkDetail(t.db, scope, workId)).editions
    expect(editions.find((e) => e.id === second?.id)?.volumeCount).toBeNull()
    expect(editions.find((e) => e.id !== second?.id)?.volumeCount).toBe(2)
  })

  it('rejects a count without a volume, and a volume above the count, as INVALID', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [{ format: 'physical' }] }))
    const [plain] = (await getWorkDetail(t.db, scope, workId)).editions
    await expect(updateEdition(t.db, scope, plain?.id ?? '', { volumeCount: 2 })).rejects.toMatchObject({ code: 'INVALID' })
    await updateEdition(t.db, scope, plain?.id ?? '', { volume: 1, volumeCount: 2 })
    await expect(updateEdition(t.db, scope, plain?.id ?? '', { volume: 3 })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('clearing the volume clears the count', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2)] }))
    const [only] = (await getWorkDetail(t.db, scope, workId)).editions
    await updateEdition(t.db, scope, only?.id ?? '', { volume: null })
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]).toMatchObject({ volume: null, volumeCount: null })
  })

  it('splitting a volume off clears its volume fields', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2), vol(2, 2)] }))
    const second = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.volume === 2)
    const newWorkId = await splitEdition(t.db, scope, second?.id ?? '')
    expect((await getWorkDetail(t.db, scope, newWorkId)).editions[0]).toMatchObject({ volume: null, volumeCount: null })
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]).toMatchObject({ volume: 1, volumeCount: 2 })
  })

  it('a new volume without a count inherits the count of its set', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2)] }))
    await addEdition(t.db, scope, workId, vol(2, null))
    expect((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.volumeCount)).toEqual([2, 2])
  })

  it('an explicit null count clears the whole set despite inheritance', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2), vol(2, 2)] }))
    const second = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.volume === 2)
    await updateEdition(t.db, scope, second?.id ?? '', { volumeCount: null })
    expect((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.volumeCount)).toEqual([null, null])
  })

  it('rejects a count below a volume already in the set, leaving the set unchanged', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 3), vol(3, 3)] }))
    const first = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.volume === 1)
    await expect(updateEdition(t.db, scope, first?.id ?? '', { volumeCount: 2 })).rejects.toMatchObject({ code: 'INVALID' })
    expect((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.volumeCount)).toEqual([3, 3])
  })

  it('createWork rejects volumes of one set that disagree on the count', async () => {
    await expect(createWork(t.db, workInput({ editions: [vol(1, 2), vol(2, 3)] }))).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('createWork lets a volume without a count inherit it', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2), vol(2, null)] }))
    expect((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.volumeCount)).toEqual([2, 2])
  })

  it('concurrent add and update on one set settle without deadlock', async () => {
    const scope = await admin()
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 2)] }))
    const [first] = (await getWorkDetail(t.db, scope, workId)).editions
    const results = await Promise.allSettled([
      addEdition(t.db, scope, workId, vol(2, 3)),
      updateEdition(t.db, scope, first?.id ?? '', { volumeCount: 4 }),
    ])
    expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    const counts = new Set((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.volumeCount))
    expect(counts.size).toBe(1)
  })
})
