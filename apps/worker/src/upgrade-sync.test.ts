import { describe, expect, it } from 'vitest'
import { createHttpClient, getConnector } from '@mylib/connectors'
import { ABS_FIXTURE_TOKEN, absFixtureFetch } from '@mylib/connectors/testing'
import { applyMigrations, createSecretBox, DEV_SECRET_KEY, editions, jobRuns, listInbox, loadUserScope, proposals, sourceItems, works } from '@mylib/db'
import { buildDatabaseAt, FIXTURE_IDS, loadFixture, TEST_MIGRATIONS_FOLDER } from '@mylib/db/testing'
import { runSyncJob } from './run-sync'

const box = createSecretBox(DEV_SECRET_KEY)

describe('a 3a database, upgraded, then synced from Audiobookshelf (spec §5)', () => {
  it('keeps the linked book untouched, files the new items, leaves an ignored-then-deleted item ignored, and duplicates nothing', async () => {
    const s = await buildDatabaseAt('3a')
    try {
      await loadFixture(s.db, '3a', { box, absToken: ABS_FIXTURE_TOKEN, arrKey: 'unused' })
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER)

      // the fixture's li_mistborn source_item stores the exact fingerprint of the connector's real test
      // item, so the sync below sees it as unchanged — snapshot the edition and work it's linked to, to
      // prove the sync makes no unexpected edit to either
      const editionBefore = (await s.db.select().from(editions)).find((e) => e.id === FIXTURE_IDS.finalEmpireAudiobookEdition)
      const workBefore = (await s.db.select().from(works)).find((w) => w.id === FIXTURE_IDS.finalEmpire)

      await runSyncJob(
        { db: s.db, box, http: createHttpClient({ fetch: absFixtureFetch('http://abs.local:13378') }), getConnector, enqueueCovers: () => Promise.resolve() },
        { sourceId: FIXTURE_IDS.absSource, runId: null },
      )

      const runs = await s.db.select().from(jobRuns)
      expect(runs.map((r) => r.status).sort()).toEqual(['succeeded', 'succeeded'])
      const items = await s.db.select().from(sourceItems)
      expect(items.find((i) => i.externalId === 'li_mistborn')).toMatchObject({ state: 'linked', workId: FIXTURE_IDS.finalEmpire })
      expect((await s.db.select({ title: works.title }).from(works)).filter((w) => w.title === 'The Final Empire')).toHaveLength(1)
      const pending = (await s.db.select().from(proposals)).filter((p) => p.status === 'pending')
      expect(new Set(pending.map((p) => p.sourceItemId)).size).toBe(pending.length)
      const noa = await loadUserScope(s.db, { id: FIXTURE_IDS.noa, role: 'admin' })
      expect((await listInbox(s.db, noa)).items.map((i) => i.item.externalId).sort()).toEqual(['li_hp1', 'li_hp1:ebook'])

      // no linked edition (or its work) gets an unexpected edit
      const editionAfter = (await s.db.select().from(editions)).find((e) => e.id === FIXTURE_IDS.finalEmpireAudiobookEdition)
      const workAfter = (await s.db.select().from(works)).find((w) => w.id === FIXTURE_IDS.finalEmpire)
      expect(editionAfter).toEqual(editionBefore)
      expect(workAfter).toEqual(workBefore)

      // an ignored proposal is never reopened: li_gone was reviewed and ignored, then deleted from
      // Audiobookshelf outright (it isn't in the connector's fixture pages at all any more) — the sync
      // marks it gone, but its state must stay 'ignored', never bounced back to 'pending'
      const goneItem = items.find((i) => i.id === FIXTURE_IDS.ignoredGoneItem)
      expect(goneItem).toMatchObject({ state: 'ignored' })
      expect(goneItem?.removedAt).not.toBeNull()
      expect(pending.some((p) => p.sourceItemId === FIXTURE_IDS.ignoredGoneItem)).toBe(false)
    } finally {
      await s.drop()
    }
  })
})
