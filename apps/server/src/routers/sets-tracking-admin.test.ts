import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string) => ({ title, authors: ['Someone'], editions: [{ format: 'physical' as const }] })

describe('sets, tracking and admin routers', () => {
  const h = useServerHarness()

  it('tracks status, rating and the queue', async () => {
    const { api } = await h.asNewUser()
    const a = (await api.catalog.create({ work: book('A') })).workId
    const b = (await api.catalog.create({ work: book('B') })).workId
    await api.tracking.setStatus({ workId: a, status: 'reading' })
    await api.tracking.setRating({ workId: a, rating: 4.5 })
    await expect(api.tracking.setRating({ workId: a, rating: 4.2 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await api.tracking.queueAdd({ workId: a })
    await api.tracking.queueAdd({ workId: b, where: 'top' })
    expect((await api.library.queue()).map((c) => c.title)).toEqual(['B', 'A'])
    await api.tracking.queueReorder({ workIds: [a, b] })
    expect((await api.library.queue()).map((c) => c.title)).toEqual(['A', 'B'])
    expect((await api.catalog.get({ workId: a })).me).toMatchObject({ status: 'reading', rating: 4.5, inQueue: true })
  })

  it('pickStatus Read records a finished read; setStatus (undo) only sets the status (#152)', async () => {
    const { api } = await h.asNewUser()
    const a = (await api.catalog.create({ work: book('A') })).workId
    const b = (await api.catalog.create({ work: book('B') })).workId
    await api.tracking.pickStatus({ workId: a, status: 'read' })
    await api.tracking.setStatus({ workId: b, status: 'read' })
    expect((await api.sessions.listForWork({ workId: a })).map((s) => [s.outcome, s.finishedPrecision])).toEqual([['finished', 'unknown']])
    expect(await api.sessions.listForWork({ workId: b })).toEqual([])
    expect((await api.catalog.get({ workId: a })).me.status).toBe('read')
  })

  it('starting a book takes it off Up next, and queueRestore puts it back where it was (#85)', async () => {
    const { api } = await h.asNewUser()
    const a = (await api.catalog.create({ work: book('A') })).workId
    const b = (await api.catalog.create({ work: book('B') })).workId
    const c = (await api.catalog.create({ work: book('C') })).workId
    for (const w of [a, b, c]) await api.tracking.queueAdd({ workId: w })
    const started = await api.sessions.start({ workId: b, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    expect(started.queuePosition).toBe(2)
    expect(typeof started.sessionId).toBe('string')
    expect((await api.library.queue()).map((x) => x.title)).toEqual(['A', 'C'])
    await api.tracking.queueRestore({ workId: b, position: 2 })
    expect((await api.library.queue()).map((x) => x.title)).toEqual(['A', 'B', 'C'])
  })

  it('reports set membership for many works', async () => {
    const { api } = await h.asNewUser()
    const a = (await api.catalog.create({ work: book('A'), addToMyBooks: false })).workId
    const b = (await api.catalog.create({ work: book('B'), addToMyBooks: false })).workId
    const set = await api.sets.create({ kind: 'manual', scope: 'personal', name: 'Beach' })
    await api.sets.addWork({ setId: set.id, workId: a })
    expect(await api.sets.membership({ workIds: [a, b] })).toEqual([{ setId: set.id, workId: a }])
    expect(await api.sets.membership({ workIds: [] })).toEqual([])
  })

  it('manages personal sets', async () => {
    const { api } = await h.asNewUser()
    const workId = (await api.catalog.create({ work: book('A'), addToMyBooks: false })).workId
    const set = await api.sets.create({ kind: 'manual', scope: 'personal', name: 'Beach' })
    await api.sets.addWork({ setId: set.id, workId })
    expect((await api.library.list({ setId: set.id, scope: 'catalog' })).items.map((i) => i.title)).toEqual(['A'])
    await api.sets.setActive({ setId: set.id, active: false })
    expect((await api.library.list({})).total).toBe(0)
    await api.sets.update({ setId: set.id, patch: { name: 'Summer' } })
    expect((await api.sets.mine()).map((s) => s.name)).toEqual(['My books', 'Summer'])
    await api.sets.delete({ setId: set.id })
    expect((await api.sets.mine()).map((s) => s.name)).toEqual(['My books'])
  })

  it('keeps admin procedures away from members', async () => {
    const { api } = await h.asNewUser()
    await expect(api.admin.users.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.sets.create({ kind: 'manual', scope: 'global', name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lets an admin create users, set PINs and reset passwords', async () => {
    const admin = await h.asNewUser('admin')
    const kid = await admin.api.admin.users.create({ username: 'kid', displayName: 'Kid', password: 'kid password', role: 'member' })
    await admin.api.admin.users.setPin({ userId: kid.id, pin: '4321' })
    await expect(h.call().api.auth.loginPin({ username: 'kid', pin: '4321' })).resolves.toMatchObject({ id: kid.id })
    await admin.api.admin.users.resetPassword({ userId: kid.id, password: 'new kid password' })
    await expect(h.call().api.auth.login({ username: 'kid', password: 'new kid password' })).resolves.toBeDefined()
    await expect(admin.api.admin.users.update({ userId: admin.user.id, patch: { role: 'member' } })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect((await admin.api.admin.users.list()).map((u) => u.username)).toContain('kid')
  })

  it('hides a book from one user end to end', async () => {
    const admin = await h.asNewUser('admin')
    const kid = await h.asNewUser()
    const { workId } = await admin.api.catalog.create({ work: book('Grown-up book') })
    await admin.api.admin.users.hideWork({ userId: kid.user.id, workId })
    expect((await admin.api.admin.users.hidden({ userId: kid.user.id })).works.map((w) => w.title)).toEqual(['Grown-up book'])
    expect((await kid.api.library.list({ scope: 'catalog' })).total).toBe(0)
    await expect(kid.api.tracking.setStatus({ workId, status: 'reading' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await admin.api.admin.users.unhideWork({ userId: kid.user.id, workId })
    expect((await kid.api.library.list({ scope: 'catalog' })).total).toBe(1)
  })

  it('assigns and hides global sets per user', async () => {
    const admin = await h.asNewUser('admin')
    const kid = await h.asNewUser()
    const shelf = await admin.api.sets.create({ kind: 'manual', scope: 'global', name: 'Kids shelf' })
    const { workId } = await admin.api.catalog.create({ work: book('Picture book'), addToMyBooks: false })
    await admin.api.sets.addWork({ setId: shelf.id, workId })
    await admin.api.admin.users.assignSet({ userId: kid.user.id, setId: shelf.id, assigned: true })
    expect((await kid.api.library.list({})).items.map((i) => i.title)).toEqual(['Picture book'])
    await admin.api.admin.users.hideSet({ userId: kid.user.id, setId: shelf.id })
    expect((await kid.api.library.list({ scope: 'catalog' })).total).toBe(0)
    const rows = await admin.api.admin.users.setAssignments({ userId: kid.user.id })
    expect(rows.map((r) => [r.name, r.assignedByAdmin, r.hidden])).toEqual([['Kids shelf', true, true]])
    expect((await admin.api.admin.sets.list()).map((s) => s.name)).toEqual(['Kids shelf'])
  })
})
