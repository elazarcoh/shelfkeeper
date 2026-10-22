import { CreateSourceInput, ExternalItem, ok, type ItemError, type Result } from '@mylib/domain'
import { createFileAssetStore } from '../asset-store'
import type { Db } from '../client'
import { loadUserScope } from '../repos/scope'
import { createSource } from '../repos/sources'
import { syncSource } from '../repos/sync'
import type { SecretBox } from '../secrets'
import { seedCover, seedProgress, seedSession, seedUser, seedWork } from './factories'
import { TEST_PNG } from './ops-env'

export interface FilledLibrary {
  adminId: string
  memberId: string
  sourceId: string
  workIds: string[]
  coverPaths: string[]
}

async function* feed(...items: ExternalItem[]): AsyncIterable<Result<ExternalItem, ItemError>> {
  await Promise.resolve()
  for (const item of items) yield ok(item)
}

/**
 * A small household with the current schema: two people, a Hebrew book, editions in every format, a
 * finished listening session with one progress point, two covers on disk, an Audiobookshelf source with a sealed token and a
 * pending Inbox proposal.
 */
export async function fillLibrary(db: Db, assetsDir: string, box: SecretBox): Promise<FilledLibrary> {
  const admin = await seedUser(db, { role: 'admin' })
  const member = await seedUser(db)
  const dune = await seedWork(db, { title: 'Dune', authors: ['Frank Herbert'], formats: ['physical', 'audiobook'], tags: ['Science fiction'], series: { name: 'Dune', position: 1 } })
  const hebrew = await seedWork(db, { title: 'סיפור על אהבה וחושך', authors: ['עמוס עוז'], formats: ['ebook'], language: 'he' })
  const listenId = await seedSession(db, {
    userId: member.id,
    workId: dune.workId,
    editionId: dune.editionIds[1] ?? null,
    mode: 'listen',
    startedOn: '2026-09-01',
    outcome: 'finished',
    finishedOn: '2026-09-03',
    fractionCompleted: 1,
  })
  await seedProgress(db, { sessionId: listenId, on: '2026-09-02', kind: 'seconds', value: 3600 })
  const store = createFileAssetStore(assetsDir)
  const coverPaths: string[] = []
  for (const [i, editionId] of [dune.editionIds[0], hebrew.editionIds[0]].entries()) {
    if (editionId === undefined) throw new Error('seedWork made no edition')
    const stored = await store.put(Uint8Array.from([...TEST_PNG, i]), 'png')
    await seedCover(db, editionId, { ...stored, mime: 'image/png' })
    coverPaths.push(stored.path)
  }
  const scope = await loadUserScope(db, admin)
  const sourceId = await createSource(
    db,
    scope,
    box,
    CreateSourceInput.parse({ name: 'Home ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://abs.local:13378', apiToken: 'abs-token' } }),
  )
  await syncSource(db, sourceId, feed(ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'The Final Empire', authors: ['Brandon Sanderson'] })))
  return { adminId: admin.id, memberId: member.id, sourceId, workIds: [dune.workId, hebrew.workId], coverPaths }
}
