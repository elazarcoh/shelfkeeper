import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHttpClient } from '@mylib/connectors'
import { assets, createFileAssetStore, createSecretBox, createSource, DEV_SECRET_KEY, editions, loadUserScope, proposals, removeStaleTempFiles, sourceItems, type Db } from '@mylib/db'
import { createScratchDatabase, endSessions, killHard, seedUser, seedWork, startChild, tempDir, waitFor, withApplicationName } from '@mylib/db/testing'
import { CreateSourceInput, ExternalItem } from '@mylib/domain'
import { recoverInterruptedRuns } from './lifecycle'
import { runCoversJob } from './run-covers'
import { runSyncJob } from './run-sync'
import { coverConnector, CRASH_ITEMS, slowConnector } from './testing/crash-sources'

const WORKER_PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const child = (name: string) => fileURLToPath(new URL(`./testing/${name}.ts`, import.meta.url))
const box = createSecretBox(DEV_SECRET_KEY)
const BASE = 'http://abs.local:13378'

async function absSource(db: Db): Promise<string> {
  const scope = await loadUserScope(db, await seedUser(db, { role: 'admin' }))
  return createSource(db, scope, box, CreateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: BASE, apiToken: 't' } }))
}

describe('crash safety in the worker (spec §7)', () => {
  it('a sync killed midway leaves whole items only, and a re-run ends where one clean sync ends', async () => {
    const s = await createScratchDatabase()
    const clean = await createScratchDatabase()
    try {
      const sourceId = await absSource(s.db)
      const app = 'crash-sync'
      const run = startChild(child('crash-sync'), { CRASH_DB_URL: withApplicationName(s.url, app), CRASH_SOURCE_ID: sourceId }, WORKER_PACKAGE)
      await waitFor(async () => (await s.db.select().from(sourceItems)).length >= 2, 'two synced items', run)
      await killHard(run)
      await endSessions(s.url, app)

      // before or after, per item: every item that exists has its one pending proposal
      const items = await s.db.select().from(sourceItems)
      const pending = (await s.db.select().from(proposals)).filter((p) => p.status === 'pending')
      expect(items.length).toBeLessThan(CRASH_ITEMS.length)
      for (const item of items) expect(pending.filter((p) => p.sourceItemId === item.id), item.externalId).toHaveLength(1)

      // the restart, then the next sync
      expect(await recoverInterruptedRuns(s.db)).toBe(1)
      const deps = (db: Db) => ({ db, box, http: createHttpClient(), getConnector: () => slowConnector(0), enqueueCovers: () => Promise.resolve() })
      await runSyncJob(deps(s.db), { sourceId, runId: null })
      await runSyncJob(deps(clean.db), { sourceId: await absSource(clean.db), runId: null })
      const shape = async (db: Db) => ({
        items: (await db.select().from(sourceItems)).map((i) => `${i.externalId}:${i.state}`).sort(),
        pending: (await db.select().from(proposals)).filter((p) => p.status === 'pending').length,
      })
      expect(await shape(s.db)).toEqual(await shape(clean.db))
    } finally {
      await s.drop()
      await clean.drop()
    }
  })

  it('a covers job killed midway leaves only whole covers, and the next job finishes them', async () => {
    const s = await createScratchDatabase()
    try {
      const sourceId = await absSource(s.db)
      for (let i = 0; i < 6; i++) {
        const { workId, editionIds } = await seedWork(s.db, { title: `Covered ${i}`, formats: ['audiobook'] })
        const normalized = ExternalItem.parse({ externalId: `li_${i}`, format: 'audiobook', title: `Covered ${i}`, coverUrl: `${BASE}/api/items/li_${i}/cover` })
        await s.db.insert(sourceItems).values({ sourceId, externalId: `li_${i}`, normalized, contentHash: 'x', state: 'linked', workId, editionId: editionIds[0] ?? null })
      }
      const assetsDir = tempDir('crash-assets')
      const app = 'crash-covers'
      const run = startChild(child('crash-covers'), { CRASH_DB_URL: withApplicationName(s.url, app), CRASH_SOURCE_ID: sourceId, CRASH_ASSETS_DIR: assetsDir }, WORKER_PACKAGE)
      await waitFor(async () => (await s.db.select().from(assets)).length >= 2, 'two saved covers', run)
      await killHard(run)
      await endSessions(s.url, app)

      // every recorded cover is a whole file with the recorded hash
      const wholeCovers = async () => {
        for (const asset of await s.db.select().from(assets)) {
          const bytes = readFileSync(path.join(assetsDir, ...asset.path.split('/')))
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
        }
      }
      await wholeCovers()
      // the restart removes temp files; the next covers job finishes the rest
      await removeStaleTempFiles(assetsDir, 0)
      expect(readdirSync(path.join(assetsDir, 'covers'), { recursive: true }).map(String).filter((f) => f.endsWith('.tmp'))).toEqual([])
      await runCoversJob({ db: s.db, box, http: createHttpClient(), getConnector: () => coverConnector(0), store: createFileAssetStore(assetsDir) }, { sourceId })
      expect((await s.db.select({ cover: editions.coverAssetId }).from(editions)).every((e) => e.cover !== null)).toBe(true)
      await wholeCovers()
    } finally {
      await s.drop()
    }
  })
})
