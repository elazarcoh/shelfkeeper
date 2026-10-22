import { describe, expect, it } from 'vitest'
import { libraryTitles, seedUser, seedWork, useTestDb, visibleTitles } from '../testing'
import { createUser } from './users'
import { loadUserScope } from './scope'
import {
  addWorkToSet,
  assignSetToUser,
  createSet,
  deleteSet,
  getDefaultPersonalSetId,
  getSetForUser,
  hideSetFromUser,
  hideWorkFromUser,
  listHiddenForUser,
  listMySets,
  listSetMembership,
  listUserSetAssignments,
  removeWorkFromSet,
  setSetActive,
  unhideWorkFromUser,
  updateSet,
} from './sets'

describe('sets repository', () => {
  const t = useTestDb()
  const scopeFor = (u: { id: string; role: 'admin' | 'member' }) => loadUserScope(t.db, u)

  it('lets only admins create global sets', async () => {
    const member = await seedUser(t.db)
    const admin = await seedUser(t.db, { role: 'admin' })
    await expect(createSet(t.db, await scopeFor(member), { kind: 'manual', scope: 'global', name: 'Shelf' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const set = await createSet(t.db, await scopeFor(admin), { kind: 'manual', scope: 'global', name: 'Shelf' })
    expect(set).toMatchObject({ scope: 'global', ownerUserId: null, active: false })
  })

  it('activates personal sets for their owner and hides them from everyone else', async () => {
    const alice = await seedUser(t.db)
    const bob = await seedUser(t.db)
    const set = await createSet(t.db, await scopeFor(alice), { kind: 'manual', scope: 'personal', name: 'Beach reads' })
    expect(set).toMatchObject({ active: true, ownerUserId: alice.id })
    await expect(getSetForUser(t.db, await scopeFor(bob), set.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lists My books first and omits hidden global sets', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const kid = await seedUser(t.db)
    const adminScope = await scopeFor(admin)
    const visible = await createSet(t.db, adminScope, { kind: 'manual', scope: 'global', name: 'Family' })
    const secret = await createSet(t.db, adminScope, { kind: 'manual', scope: 'global', name: 'Grown-ups' })
    await hideSetFromUser(t.db, adminScope, kid.id, secret.id)
    const names = (await listMySets(t.db, await scopeFor(kid))).map((s) => s.name)
    expect(names).toEqual(['My books', visible.name])
  })

  it('adds and removes works in manual sets idempotently', async () => {
    const user = await seedUser(t.db)
    const scope = await scopeFor(user)
    const w = await seedWork(t.db, { title: 'Dune' })
    const setId = await getDefaultPersonalSetId(t.db, user.id)
    await addWorkToSet(t.db, scope, setId, w.workId)
    await addWorkToSet(t.db, scope, setId, w.workId)
    expect(await libraryTitles(t.db, await scopeFor(user))).toEqual(['Dune'])
    await removeWorkFromSet(t.db, scope, setId, w.workId)
    expect(await libraryTitles(t.db, await scopeFor(user))).toEqual([])
  })

  it('rejects adding to smart sets, hidden works, and others’ global sets', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const member = await seedUser(t.db)
    const adminScope = await scopeFor(admin)
    const w = await seedWork(t.db, { title: 'Dune' })
    const smart = await createSet(t.db, adminScope, {
      kind: 'smart',
      scope: 'global',
      name: 'Audio',
      filter: { op: 'format', formats: ['audiobook'] },
    })
    await expect(addWorkToSet(t.db, adminScope, smart.id, w.workId)).rejects.toMatchObject({ code: 'INVALID' })

    const shelf = await createSet(t.db, adminScope, { kind: 'manual', scope: 'global', name: 'Shelf' })
    await expect(addWorkToSet(t.db, await scopeFor(member), shelf.id, w.workId)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await hideWorkFromUser(t.db, adminScope, member.id, w.workId)
    const mine = await getDefaultPersonalSetId(t.db, member.id)
    await expect(addWorkToSet(t.db, await scopeFor(member), mine, w.workId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('toggles whether a global set feeds the personal library', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const user = await seedUser(t.db)
    const adminScope = await scopeFor(admin)
    const w = await seedWork(t.db, { title: 'Shared' })
    const shelf = await createSet(t.db, adminScope, { kind: 'manual', scope: 'global', name: 'Shelf' })
    await addWorkToSet(t.db, adminScope, shelf.id, w.workId)
    await setSetActive(t.db, await scopeFor(user), shelf.id, true)
    expect(await libraryTitles(t.db, await scopeFor(user))).toEqual(['Shared'])
    await setSetActive(t.db, await scopeFor(user), shelf.id, false)
    expect(await libraryTitles(t.db, await scopeFor(user))).toEqual([])
  })

  it('protects My books and validates updates', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const scope = await scopeFor(admin)
    const mine = await getDefaultPersonalSetId(t.db, admin.id)
    await expect(deleteSet(t.db, scope, mine)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(updateSet(t.db, scope, mine, { filter: { op: 'format', formats: ['ebook'] } })).rejects.toMatchObject({
      code: 'INVALID',
    })
    await expect(updateSet(t.db, scope, mine, { defaultForNewUsers: true })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(updateSet(t.db, scope, mine, { name: 'Our books' })).resolves.toMatchObject({ name: 'Our books' })
  })

  it('assigns default global sets to new users when flagged', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const scope = await scopeFor(admin)
    const kids = await createSet(t.db, scope, { kind: 'manual', scope: 'global', name: 'Kids' })
    await updateSet(t.db, scope, kids.id, { defaultForNewUsers: true })
    const child = await createUser(t.db, { username: 'kid', displayName: 'Kid', passwordHash: 'x', role: 'member' })
    expect(await getSetForUser(t.db, await scopeFor(child), kids.id)).toMatchObject({ active: true, assignedByAdmin: true })
  })

  it('lets admins assign, hide and list per-user sets and works', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const kid = await seedUser(t.db)
    const scope = await scopeFor(admin)
    const shelf = await createSet(t.db, scope, { kind: 'manual', scope: 'global', name: 'Shelf' })
    const grown = await createSet(t.db, scope, { kind: 'manual', scope: 'global', name: 'Grown-ups' })
    const w = await seedWork(t.db, { title: 'Secret' })
    await seedWork(t.db, { title: 'Fine' })

    await assignSetToUser(t.db, scope, kid.id, shelf.id, true)
    await hideSetFromUser(t.db, scope, kid.id, grown.id)
    await hideWorkFromUser(t.db, scope, kid.id, w.workId)
    const assignments = await listUserSetAssignments(t.db, scope, kid.id)
    expect(assignments.map((a) => [a.name, a.assignedByAdmin, a.hidden])).toEqual([
      ['Grown-ups', false, true],
      ['Shelf', true, false],
    ])
    expect(await listHiddenForUser(t.db, scope, kid.id)).toEqual({
      works: [{ id: w.workId, title: 'Secret' }],
      sets: [{ id: grown.id, name: 'Grown-ups' }],
    })
    expect(await visibleTitles(t.db, await scopeFor(kid))).toEqual(['Fine'])
    await unhideWorkFromUser(t.db, scope, kid.id, w.workId)
    expect(await visibleTitles(t.db, await scopeFor(kid))).toEqual(['Fine', 'Secret'])

    const mine = await getDefaultPersonalSetId(t.db, kid.id)
    await expect(assignSetToUser(t.db, scope, kid.id, mine, true)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(assignSetToUser(t.db, await scopeFor(kid), kid.id, shelf.id, true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('unassigning deactivates only admin-assigned sets, not ones the user turned on', async () => {
    const admin = await scopeFor(await seedUser(t.db, { role: 'admin' }))
    const kid = await seedUser(t.db)
    const kidScope = await scopeFor(kid)
    const chosen = await createSet(t.db, admin, { kind: 'manual', scope: 'global', name: 'Chosen' })
    const assigned = await createSet(t.db, admin, { kind: 'manual', scope: 'global', name: 'Assigned' })

    await setSetActive(t.db, kidScope, chosen.id, true)
    await assignSetToUser(t.db, admin, kid.id, chosen.id, false)
    expect(await getSetForUser(t.db, kidScope, chosen.id)).toMatchObject({ active: true, assignedByAdmin: false })

    await assignSetToUser(t.db, admin, kid.id, assigned.id, true)
    await assignSetToUser(t.db, admin, kid.id, assigned.id, false)
    expect(await getSetForUser(t.db, kidScope, assigned.id)).toMatchObject({ active: false, assignedByAdmin: false })
  })

  it('lists which accessible sets hold which of the given works', async () => {
    const alice = await seedUser(t.db)
    const bob = await seedUser(t.db)
    const a = await seedWork(t.db, { title: 'A' })
    const b = await seedWork(t.db, { title: 'B' })
    const c = await seedWork(t.db, { title: 'C' })
    const aliceScope = await scopeFor(alice)
    const bobScope = await scopeFor(bob)
    const mine = await getDefaultPersonalSetId(t.db, alice.id)
    const bobs = await getDefaultPersonalSetId(t.db, bob.id)
    await addWorkToSet(t.db, aliceScope, mine, a.workId)
    await addWorkToSet(t.db, aliceScope, mine, b.workId)
    await addWorkToSet(t.db, bobScope, bobs, a.workId)
    const rows = await listSetMembership(t.db, aliceScope, [a.workId, b.workId, c.workId])
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([{ setId: mine, workId: a.workId }, { setId: mine, workId: b.workId }]))
  })

  it('lists no membership for no works', async () => {
    const user = await seedUser(t.db)
    expect(await listSetMembership(t.db, await scopeFor(user), [])).toEqual([])
  })
})
