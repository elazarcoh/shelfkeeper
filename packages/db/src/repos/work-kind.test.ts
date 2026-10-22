import { describe, expect, it } from 'vitest'
import { WishFields } from '@mylib/domain'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail, splitEdition, updateWork } from './catalog'
import { getWorkCards } from './library'
import { loadUserScope } from './scope'
import { listWishes, upsertWish } from './wishlist'

describe('work kind (#133)', () => {
  const t = useTestDb()
  const member = async () => loadUserScope(t.db, await seedUser(t.db))

  it('is a book unless set, and creating without it leaves it unlocked', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput())
    const detail = await getWorkDetail(t.db, scope, id)
    expect(detail.kind).toBe('book')
    expect(detail.provenance.kind).toBeUndefined()
  })

  it('locks the kind when it is edited, and only then', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput())
    await updateWork(t.db, scope, id, { title: 'New' })
    expect((await getWorkDetail(t.db, scope, id)).provenance.kind).toBeUndefined()
    await updateWork(t.db, scope, id, { kind: 'fanfiction' })
    const detail = await getWorkDetail(t.db, scope, id)
    expect(detail.kind).toBe('fanfiction')
    expect(detail.provenance.kind?.locked).toBe(true)
  })

  it('creates a work of the given kind', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput({ kind: 'web_serial' }))
    expect((await getWorkDetail(t.db, scope, id)).kind).toBe('web_serial')
  })

  it('carries the kind on cards and wishes', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput({ kind: 'fanfiction' }))
    expect((await getWorkCards(t.db, scope, [id]))[0]?.kind).toBe('fanfiction')
    await upsertWish(t.db, scope, id, WishFields.parse({ formats: [] }))
    expect((await listWishes(t.db, scope, scope.userId))[0]?.kind).toBe('fanfiction')
  })

  it('keeps the kind on the work a split-off edition becomes', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput({ kind: 'fanfiction', editions: [{ format: 'physical' }, { format: 'ebook' }] }))
    const [, second] = (await getWorkDetail(t.db, scope, id)).editions
    const split = await splitEdition(t.db, scope, second?.id ?? '')
    expect((await getWorkDetail(t.db, scope, split)).kind).toBe('fanfiction')
  })
})
