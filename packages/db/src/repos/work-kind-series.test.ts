import { describe, expect, it } from 'vitest'
import { seedUser, seedWork, useTestDb } from '../testing'
import { getWorkDetail, setSeriesKind } from './catalog'
import { loadUserScope } from './scope'
import { hideWorkFromUser } from './sets'

describe('mark a whole series (#133)', () => {
  const t = useTestDb()

  it('changes only the works this person can see, and counts the ones that changed', async () => {
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const member = await seedUser(t.db)
    const scope = await loadUserScope(t.db, member)
    const a = await seedWork(t.db, { title: 'One', series: { name: 'Saga', position: 1 } })
    const b = await seedWork(t.db, { title: 'Two', series: { name: 'Saga', position: 2 } })
    const c = await seedWork(t.db, { title: 'Three', series: { name: 'Saga', position: 3 } })
    await hideWorkFromUser(t.db, admin, member.id, c.workId)
    expect(await setSeriesKind(t.db, scope, a.seriesId ?? '', 'web_serial')).toEqual({ changed: 2 })
    // the same again: still locked, but nothing changed value
    expect(await setSeriesKind(t.db, scope, a.seriesId ?? '', 'web_serial')).toEqual({ changed: 0 })
    for (const id of [a.workId, b.workId]) {
      const d = await getWorkDetail(t.db, scope, id)
      expect(d.kind).toBe('web_serial')
      expect(d.provenance.kind?.locked).toBe(true)
    }
    const hidden = await getWorkDetail(t.db, admin, c.workId)
    expect(hidden.kind).toBe('book')
    expect(hidden.provenance.kind).toBeUndefined()
  })
})
