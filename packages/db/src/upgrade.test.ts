import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from './ops/migrations'
import { getWorkDetail } from './repos/catalog'
import { findVisibleAsset } from './repos/covers'
import { listMyProposals } from './repos/csv-import'
import { listGoals } from './repos/goals'
import { listInbox } from './repos/inbox'
import { addProgressPoint } from './repos/progress'
import { loadUserScope } from './repos/scope'
import { loadSourceForSync } from './repos/sources'
import { getDailyStats } from './repos/stats'
import { createSecretBox, DEV_SECRET_KEY } from './secrets'
import { buildDatabaseAt, FIXTURE_IDS, loadFixture, snapshotPublicTables, TEST_MIGRATIONS_FOLDER, visibleTitles, type Release } from './testing'

const box = createSecretBox(DEV_SECRET_KEY)
const asText = (rows: readonly Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).sort()
const pick = (row: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]))
// 0021 (#124): work.language, after 0020 copied it onto the editions
// 0022 (#122): work_series.position_end, a series range
// 0023 (#72): hardcover_* tables
// 0024 (#56): what-next tables (hardcover cache, hidden picks, author follows, prefs)
// 0025 (#56): hardcover_missing_book, ids Hardcover did not return
// 0026 (#133): work.kind, backfilled from fanfiction / web serial tags
// 0027 (#145): work_title and series_name, backfilled from the book and series names; language codes normalized
// 0029 (#152): reading_session rows for read books that had no finished read (unknown date)
const DROPPED_COLUMNS: Record<string, readonly string[]> = { work: ['language'] }

// Dan's one finished listen (spec §4.4, packages/domain/src/sessions.ts): fixture reading_session
// 61111111-…0001 is mode 'listen', fractionCompleted 1, on edition e1111111-…0002 whose duration_sec is
// 88035 (unlocked in its provenance, so nothing here is stale) -> 88035s / 60 = 1467.25 minutes total,
// spread evenly across the 10 inclusive days 2026-03-01..2026-03-10 the started/finished dates union to
// (146.725 min/day). All 10 days fall in March, so the range's whole total is the March total: 1467.25.
const MARCH_LISTEN_MINUTES = 1467.25

// Noa's in-progress read of the Hebrew ebook (fixture reading_session 61111111-…0002, started 2026-09-01, edition
// e1111111-…0003 with word_count 180000): a 50% point on 2026-09-11 is 90,000 words over Sep 1–11 — a number that
// only appears if the upgraded database has the new table and the new stats derivation works on old rows.
const NOA_SEPTEMBER_WORDS = 90_000
// the server's clock pinned to the point's client "today", so the ±2-day client-date check never depends on the run date
const SERVER_NOW = new Date('2026-10-06T12:00:00Z')

describe('upgrades from released schemas (spec §5)', () => {
  for (const release of ['3a', '3b', '3c'] as const satisfies readonly Release[]) {
    it(`keeps every ${release} row, with the same meaning, through the current migrations`, async () => {
      const s = await buildDatabaseAt(release)
      try {
        await loadFixture(s.db, release, { box, absToken: 'fixture-token', arrKey: 'arr-key' })
        const before = await snapshotPublicTables(s.db)
        const applied = await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER)
        expect(applied).not.toEqual([])
        // an upgrade from 3c applies reading progress, the hidden continuations, the shelf source kind and the
        // check-in marks and the wishlist and the edition volumes and the progress editions and their per-volume days and the search abbreviations and the contributor names and the health ignores and the edition languages and the dropped book language, nothing else
        if (release === '3c') expect(applied).toEqual(['0008_reading_progress', '0009_hidden_continuation', '0010_shelf_source_kind', '0011_checkin_mark', '0012_wish', '0013_edition_volume', '0014_progress_edition', '0015_progress_edition_day', '0016_search_acronyms', '0017_contributor_names', '0018_person_name_guard', '0019_health_ignore', '0020_edition_language', '0021_work_language_drop', '0022_series_position_end', '0023_hardcover', '0024_what_next', '0025_hardcover_missing_book', '0026_work_kind', '0027_title_languages', '0028_abs_push', '0029_read_status_sessions'])
        const after = await snapshotPublicTables(s.db)

        // every old table keeps exactly its row count (migrations change schema, never business data)
        for (const [table, rows] of Object.entries(before)) {
          expect(after[table]?.length, `${table} row count`).toBe(rows.length)
        }
        // every old row is still there, unchanged in every column it had (new columns may be added), except
        // the columns a two-release plan dropped (migration-rules.ts allow list)
        for (const [table, rows] of Object.entries(before)) {
          const keys = Object.keys(rows[0] ?? {}).filter((k) => !DROPPED_COLUMNS[table]?.includes(k))
          if (keys.length === 0) continue
          expect(asText((after[table] ?? []).map((row) => pick(row, keys))), table).toEqual(asText(rows.map((row) => pick(row, keys))))
        }
        // 0021: the book's language is gone; its editions carry it (0020)
        for (const row of after['work'] ?? []) expect(row).not.toHaveProperty('language')
        // 0008: the new table arrives empty, and no old row moved into or out of it
        expect(before['reading_progress']).toBeUndefined()
        expect(after['reading_progress']).toEqual([])
        // 0009: likewise, no series starts out hidden from Series continuation
        expect(before['user_hidden_continuation']).toBeUndefined()
        expect(after['user_hidden_continuation']).toEqual([])
        // 0011: no book starts out checked in on
        expect(before['checkin_mark']).toBeUndefined()
        expect(after['checkin_mark']).toEqual([])
        // 0012: no one starts out wishing for anything
        expect(before['wish']).toBeUndefined()
        expect(after['wish']).toEqual([])
        // 0016: old search rows have no abbreviations yet, so the start-up backfill (acronyms is null) picks every one up
        expect(after['work_search']?.length).toBeGreaterThan(0)
        for (const row of after['work_search'] ?? []) expect(row['acronyms']).toBeNull()
        // 0017: every person has their name as a name row, and every book link credits it
        expect(after['contributor_name']?.length).toBe(after['contributor']?.length)
        for (const row of after['contributor'] ?? []) expect(row['curated']).toBe(false)
        const namesById = new Map((after['contributor_name'] ?? []).map((n) => [n['id'], n]))
        const links = [...(after['work_contributor'] ?? []), ...(after['edition_contributor'] ?? [])]
        expect(links.length).toBeGreaterThan(0)
        for (const link of links) {
          expect(namesById.get(link['name_id'])?.['contributor_id']).toBe(link['contributor_id'])
        }
        // 0018: both links are guarded, so a link credits only a name of its own person
        const guards = await s.db.execute<{ conname: string }>(sql`select conname from pg_constraint where conname like '%_name_of_person_fk' order by conname`)
        expect(guards.map((g) => g.conname)).toEqual(['edition_contributor_name_of_person_fk', 'work_contributor_name_of_person_fk'])
        if (release === '3c') expect(after['backup_settings']?.[0]).toMatchObject({ schedule: '0 3 * * *', keep_scheduled: 10 })

        // and it still means the same thing to the app
        const noa = await loadUserScope(s.db, { id: FIXTURE_IDS.noa, role: 'admin' })
        const dan = await loadUserScope(s.db, { id: FIXTURE_IDS.dan, role: 'member' })
        const empire = await getWorkDetail(s.db, noa, FIXTURE_IDS.finalEmpire)
        expect(empire.title).toBe('The Final Empire')
        expect(empire.editions.map((e) => e.format).sort()).toEqual(['audiobook', 'physical'])
        expect((await getWorkDetail(s.db, noa, FIXTURE_IDS.hebrewBook)).title).toBe('סיפור על אהבה וחושך')
        expect(await visibleTitles(s.db, dan)).not.toContain('Hidden Book')
        expect((await loadSourceForSync(s.db, box, FIXTURE_IDS.absSource))?.config).toMatchObject({ apiToken: 'fixture-token' })
        expect((await listInbox(s.db, noa)).items.map((i) => i.item.externalId)).toContain('li_hp1')
        const march = await getDailyStats(s.db, dan, { from: '2026-03-01', to: '2026-03-31' })
        // a headline number, not just "no error": the exact minutes derived from the fixture's session above
        expect(march.reduce((sum, d) => sum + d.minutes, 0)).toBeCloseTo(MARCH_LISTEN_MINUTES, 5)
        expect(await listGoals(s.db, dan)).toHaveLength(1)
        expect(await findVisibleAsset(s.db, noa, FIXTURE_IDS.cover3a)).not.toBeNull()
        if (release !== '3a') {
          expect((await listMyProposals(s.db, dan)).items.map((p) => p.item.title)).toEqual(['Project Hail Mary'])
          expect((await loadSourceForSync(s.db, box, FIXTURE_IDS.readarrSource))?.config).toMatchObject({ apiKey: 'arr-key' })
          expect(await findVisibleAsset(s.db, noa, FIXTURE_IDS.cover3b)).not.toBeNull()
        }
        await addProgressPoint(s.db, noa, { sessionId: FIXTURE_IDS.noaReadingSession, today: '2026-10-06', on: '2026-09-11', kind: 'percent', value: 50 }, { now: SERVER_NOW })
        const september = await getDailyStats(s.db, noa, { from: '2026-09-01', to: '2026-09-30' })
        expect(september.reduce((sum, d) => sum + d.words, 0)).toBeCloseTo(NOA_SEPTEMBER_WORDS, 5)
      } finally {
        await s.drop()
      }
    })
  }

  // 0014: progress points take their session's edition; a session without one leaves its points without
  it('backfills reading_progress.edition_id from the session on real rows', async () => {
    const s = await buildDatabaseAt('3c')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0013_edition_volume' })
      const ids = {
        user: 'a2222222-2222-4222-8222-000000000001',
        work: 'b2222222-2222-4222-8222-000000000001',
        edition: 'e2222222-2222-4222-8222-000000000001',
        withEdition: '62222222-2222-4222-8222-000000000001',
        withoutEdition: '62222222-2222-4222-8222-000000000002',
      }
      await s.db.execute(sql`insert into app_user (id, username, display_name, password_hash, role) values (${ids.user}, 'backfill', 'Backfill', 'x', 'member')`)
      await s.db.execute(sql`insert into work (id, title, sort_title) values (${ids.work}, 'Backfill', 'backfill')`)
      await s.db.execute(sql`insert into edition (id, work_id, format) values (${ids.edition}, ${ids.work}, 'physical')`)
      await s.db.execute(sql`insert into reading_session (id, user_id, work_id, edition_id, mode, started_on) values (${ids.withEdition}, ${ids.user}, ${ids.work}, ${ids.edition}, 'read', '2026-10-01')`)
      await s.db.execute(sql`insert into reading_session (id, user_id, work_id, edition_id, mode, started_on) values (${ids.withoutEdition}, ${ids.user}, ${ids.work}, null, 'read', '2026-10-01')`)
      for (const sessionId of [ids.withEdition, ids.withoutEdition]) {
        await s.db.execute(sql`insert into reading_progress (session_id, occurred_on, kind, value) values (${sessionId}, '2026-10-02', 'page', 10), (${sessionId}, '2026-10-03', 'page', 20)`)
      }
      const applied = await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER)
      expect(applied).toEqual(['0014_progress_edition', '0015_progress_edition_day', '0016_search_acronyms', '0017_contributor_names', '0018_person_name_guard', '0019_health_ignore', '0020_edition_language', '0021_work_language_drop', '0022_series_position_end', '0023_hardcover', '0024_what_next', '0025_hardcover_missing_book', '0026_work_kind', '0027_title_languages', '0028_abs_push', '0029_read_status_sessions'])
      const rows = await s.db.execute<{ session_id: string; edition_id: string | null }>(sql`select session_id, edition_id from reading_progress order by session_id, occurred_on`)
      expect(rows).toHaveLength(4)
      expect(rows.filter((r) => r.session_id === ids.withEdition).map((r) => r.edition_id)).toEqual([ids.edition, ids.edition])
      expect(rows.filter((r) => r.session_id === ids.withoutEdition).map((r) => r.edition_id)).toEqual([null, null])
      // 0015: the points survive, a day may hold a point per volume, and a day still holds one point without a volume
      await s.db.execute(sql`insert into reading_progress (session_id, occurred_on, kind, value, edition_id) values (${ids.withEdition}, '2026-10-02', 'page', 5, null)`)
      await expect(s.db.execute(sql`insert into reading_progress (session_id, occurred_on, kind, value, edition_id) values (${ids.withEdition}, '2026-10-02', 'page', 6, null)`)).rejects.toThrow()
      await expect(s.db.execute(sql`insert into reading_progress (session_id, occurred_on, kind, value, edition_id) values (${ids.withEdition}, '2026-10-02', 'page', 7, ${ids.edition})`)).rejects.toThrow()
    } finally {
      await s.drop()
    }
  })

  // 0020 (#124): a book's language moves onto its editions that have none; editions with one keep it
  it('copies work.language onto editions without a language', async () => {
    const s = await buildDatabaseAt('3c')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0019_health_ignore' })
      const ids = {
        he: 'b3333333-3333-4333-8333-000000000001',
        none: 'b3333333-3333-4333-8333-000000000002',
        blank: 'e3333333-3333-4333-8333-000000000001',
        english: 'e3333333-3333-4333-8333-000000000002',
        orphan: 'e3333333-3333-4333-8333-000000000003',
      }
      await s.db.execute(sql`insert into work (id, title, sort_title, language) values (${ids.he}, 'Hebrew book', 'hebrew book', 'he'), (${ids.none}, 'No language', 'no language', null)`)
      await s.db.execute(sql`insert into edition (id, work_id, format, language) values (${ids.blank}, ${ids.he}, 'physical', null), (${ids.english}, ${ids.he}, 'ebook', 'en'), (${ids.orphan}, ${ids.none}, 'physical', null)`)
      expect(await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0020_edition_language' })).toEqual(['0020_edition_language'])
      const rows = await s.db.execute<{ id: string; language: string | null }>(sql`select id, language from edition where id in (${ids.blank}, ${ids.english}, ${ids.orphan}) order by id`)
      expect(rows.map((r) => [r.id, r.language])).toEqual([
        [ids.blank, 'he'],
        [ids.english, 'en'],
        [ids.orphan, null],
      ])
    } finally {
      await s.drop()
    }
  })

  // 0026 (#133): a book tagged like fanfiction or a web serial takes that kind, recorded as automatic and unlocked
  it('backfills work.kind from fanfiction and web serial tags', async () => {
    const s = await buildDatabaseAt('3c')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0025_hardcover_missing_book' })
      const ids = {
        fan: 'b4444444-4444-4444-8444-000000000001',
        serial: 'b4444444-4444-4444-8444-000000000002',
        plain: 'b4444444-4444-4444-8444-000000000003',
        both: 'b4444444-4444-4444-8444-000000000004',
        fanTag: 'a4444444-4444-4444-8444-000000000001',
        serialTag: 'a4444444-4444-4444-8444-000000000002',
        otherTag: 'a4444444-4444-4444-8444-000000000003',
      }
      await s.db.execute(sql`insert into work (id, title, sort_title, provenance) values (${ids.fan}, 'Fan', 'fan', '{"title":{"origin":"manual","at":"2026-01-01T00:00:00.000Z","locked":true}}'), (${ids.serial}, 'Serial', 'serial', '{}'), (${ids.plain}, 'Plain', 'plain', '{}'), (${ids.both}, 'Both', 'both', '{}')`)
      await s.db.execute(sql`insert into tag (id, name, normalized_name) values (${ids.fanTag}, 'Fan Fiction', 'fan fiction'), (${ids.serialTag}, 'Web-Novel', 'web-novel'), (${ids.otherTag}, 'Epic Fantasy', 'epic fantasy')`)
      await s.db.execute(sql`insert into work_tag (work_id, tag_id) values (${ids.fan}, ${ids.fanTag}), (${ids.serial}, ${ids.serialTag}), (${ids.plain}, ${ids.otherTag}), (${ids.both}, ${ids.serialTag}), (${ids.both}, ${ids.fanTag})`)
      expect(await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER)).toEqual(['0026_work_kind', '0027_title_languages', '0028_abs_push', '0029_read_status_sessions'])
      const rows = await s.db.execute<{ id: string; kind: string; provenance: Record<string, { origin: string; locked: boolean; sourceId?: string }> }>(sql`select id, kind, provenance from work where id in (${ids.fan}, ${ids.serial}, ${ids.plain}, ${ids.both}) order by id`)
      expect(rows.map((r) => [r.id, r.kind])).toEqual([
        [ids.fan, 'fanfiction'],
        [ids.serial, 'web_serial'],
        [ids.plain, 'book'],
        [ids.both, 'fanfiction'],
      ])
      const [fan, , plain] = rows
      expect(fan?.provenance['kind']).toMatchObject({ origin: 'source', locked: false })
      expect(fan?.provenance['kind']?.sourceId).toBeUndefined()
      // the work's other provenance entries stay
      expect(fan?.provenance['title']).toMatchObject({ origin: 'manual', locked: true })
      expect(plain?.provenance['kind']).toBeUndefined()
    } finally {
      await s.drop()
    }
  })

  // 0027 (#145): every book gets a primary title row, every series a name row, and language labels become codes
  it('backfills work_title and series_name and normalizes language codes', async () => {
    const s = await buildDatabaseAt('3c')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0026_work_kind' })
      const w = (n: number) => `b5555555-5555-4555-8555-00000000000${n}`
      const e = (n: number) => `e5555555-5555-4555-8555-00000000000${n}`
      const sr = (n: number) => `c5555555-5555-4555-8555-00000000000${n}`
      await s.db.execute(sql`insert into work (id, title, sort_title, subtitle) values (${w(1)}, 'קצב המלחמה', 'קצב המלחמה', null), (${w(2)}, 'Dune', 'dune', 'Book One'), (${w(3)}, '1984', '1984', null), (${w(4)}, '1984', '1984', null)`)
      await s.db.execute(sql`insert into edition (id, work_id, format, language) values (${e(1)}, ${w(1)}, 'physical', 'English'), (${e(2)}, ${w(2)}, 'physical', 'eng'), (${e(3)}, ${w(2)}, 'ebook', 'en'), (${e(4)}, ${w(3)}, 'physical', 'he'), (${e(5)}, ${w(3)}, 'ebook', 'en')`)
      await s.db.execute(sql`insert into series (id, name, normalized_name) values (${sr(1)}, 'גנזך אורות הסער', 'גנזך אורות הסער'), (${sr(2)}, 'Stormlight Archive', 'stormlight archive')`)
      await s.db.execute(sql`insert into contributor (id, name, sort_name, normalized_name) values (${sr(3)}, 'Person', 'person', 'person')`)
      await s.db.execute(sql`insert into contributor_name (contributor_id, name, normalized_name, language) values (${sr(3)}, 'Person', 'person', 'Hebrew')`)
      await s.db.execute(sql`insert into work_search (work_id, document, title_text, series_text, author_text, other_text, acronyms) values (${w(1)}, 'd', 't', '', '', '', 'x')`)
      const userId = sr(4)
      await s.db.execute(sql`insert into app_user (id, username, display_name, password_hash) values (${userId}, 'wisher', 'Wisher', 'x')`)
      await s.db.execute(sql`insert into wish (user_id, work_id, language) values (${userId}, ${w(4)}, 'English')`)

      expect(await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER)).toEqual(['0027_title_languages', '0028_abs_push', '0029_read_status_sessions'])

      const titles = await s.db.execute<{ work_id: string; language: string | null; title: string; subtitle: string | null; sort_title: string; primary: boolean }>(sql`select work_id, language, title, subtitle, sort_title, "primary" from work_title where work_id in (${w(1)}, ${w(2)}, ${w(3)}, ${w(4)}) order by work_id`)
      expect(titles).toEqual([
        { work_id: w(1), language: 'he', title: 'קצב המלחמה', subtitle: null, sort_title: 'קצב המלחמה', primary: true },
        { work_id: w(2), language: 'en', title: 'Dune', subtitle: 'Book One', sort_title: 'dune', primary: true },
        { work_id: w(3), language: null, title: '1984', subtitle: null, sort_title: '1984', primary: true },
        { work_id: w(4), language: null, title: '1984', subtitle: null, sort_title: '1984', primary: true },
      ])
      // one primary per work, across the whole database
      const total = await s.db.execute<{ works: number; primaries: number }>(sql`select (select count(*) from work)::int as works, (select count(*) from work_title where "primary")::int as primaries`)
      expect(total[0]?.primaries).toBe(total[0]?.works)
      const eds = await s.db.execute<{ id: string; language: string }>(sql`select id, language from edition where id in (${e(1)}, ${e(2)}, ${e(3)}) order by id`)
      expect(eds.map((r) => r.language)).toEqual(['en', 'en', 'en'])
      const names = await s.db.execute<{ name: string; normalized_name: string; language: string | null }>(sql`select name, normalized_name, language from series_name where series_id in (${sr(1)}, ${sr(2)}) order by name`)
      expect(names).toEqual([
        { name: 'Stormlight Archive', normalized_name: 'stormlight archive', language: 'en' },
        { name: 'גנזך אורות הסער', normalized_name: 'גנזך אורות הסער', language: 'he' },
      ])
      const seriesCount = await s.db.execute<{ n: number; m: number }>(sql`select (select count(*) from series)::int as n, (select count(*) from series_name)::int as m`)
      expect(seriesCount[0]?.m).toBe(seriesCount[0]?.n)
      expect((await s.db.execute<{ language: string }>(sql`select language from contributor_name where contributor_id = ${sr(3)}`))[0]?.language).toBe('he')
      expect((await s.db.execute<{ language: string }>(sql`select language from wish where work_id = ${w(4)}`))[0]?.language).toBe('en')
      for (const row of await s.db.execute<{ acronyms: string | null }>(sql`select acronyms from work_search`)) expect(row.acronyms).toBeNull()
      // the new user column defaults to English then Hebrew
      expect((await s.db.execute<{ title_languages: string[] }>(sql`select title_languages from app_user limit 1`))[0]?.title_languages).toEqual(['en', 'he'])
    } finally {
      await s.drop()
    }
  })

  // 0029 (#152): a book with status read and no finished read gets one, dated unknown on the day the status changed
  it('backfills a finished read with an unknown date for read books without one, once', async () => {
    const s = await buildDatabaseAt('3c')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0028_abs_push' })
      const w = (n: number) => `b6666666-6666-4666-8666-00000000000${n}`
      const userId = 'a6666666-6666-4666-8666-000000000001'
      const kept = 'c6666666-6666-4666-8666-000000000001'
      await s.db.execute(sql`insert into app_user (id, username, display_name, password_hash) values (${userId}, 'reader152', 'Reader', 'x')`)
      await s.db.execute(sql`insert into work (id, title, sort_title) values (${w(1)}, 'Paper', 'paper'), (${w(2)}, 'Audio', 'audio'), (${w(3)}, 'Has read', 'has read'), (${w(4)}, 'Reading', 'reading')`)
      await s.db.execute(sql`insert into edition (work_id, format) values (${w(1)}, 'physical'), (${w(1)}, 'audiobook'), (${w(2)}, 'audiobook')`)
      await s.db.execute(sql`insert into user_work (user_id, work_id, status, updated_at) values (${userId}, ${w(1)}, 'read', '2025-03-04T23:30:00Z'), (${userId}, ${w(2)}, 'read', '2025-05-06T10:00:00Z'), (${userId}, ${w(3)}, 'read', '2025-07-08T10:00:00Z'), (${userId}, ${w(4)}, 'reading', '2025-07-08T10:00:00Z')`)
      await s.db.execute(sql`insert into reading_session (id, user_id, work_id, mode, started_on, finished_on, finished_precision, outcome, fraction_completed) values (${kept}, ${userId}, ${w(3)}, 'read', '2024-01-01', '2024-01-10', 'day', 'finished', 1)`)

      expect(await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER)).toEqual(['0029_read_status_sessions'])

      const rows = await s.db.execute<{ id: string; work_id: string; edition_id: string | null; mode: string; started_on: string; started_precision: string; finished_on: string; finished_precision: string; outcome: string; fraction_completed: number; is_reread: boolean; created_at: Date }>(
        sql`select id, work_id, edition_id, mode, started_on::text, started_precision, finished_on::text, finished_precision, outcome, fraction_completed, is_reread, created_at from reading_session where user_id = ${userId} order by work_id`,
      )
      expect(rows.map((r) => ({ ...r, id: r.id === kept ? 'kept' : 'new', created_at: new Date(r.created_at).toISOString() }))).toEqual([
        { id: 'new', work_id: w(1), edition_id: null, mode: 'read', started_on: '2025-03-04', started_precision: 'unknown', finished_on: '2025-03-04', finished_precision: 'unknown', outcome: 'finished', fraction_completed: 1, is_reread: false, created_at: '2025-03-04T23:30:00.000Z' },
        { id: 'new', work_id: w(2), edition_id: null, mode: 'listen', started_on: '2025-05-06', started_precision: 'unknown', finished_on: '2025-05-06', finished_precision: 'unknown', outcome: 'finished', fraction_completed: 1, is_reread: false, created_at: '2025-05-06T10:00:00.000Z' },
        { id: 'kept', work_id: w(3), edition_id: null, mode: 'read', started_on: '2024-01-01', started_precision: 'day', finished_on: '2024-01-10', finished_precision: 'day', outcome: 'finished', fraction_completed: 1, is_reread: false, created_at: expect.any(String) as string },
      ])
      // run again (a restored backup taken mid-upgrade): nothing new
      const before = (await s.db.execute<{ n: number }>(sql`select count(*)::int as n from reading_session`))[0]?.n
      await s.db.execute(sql.raw(readFileSync(path.join(TEST_MIGRATIONS_FOLDER, '0029_read_status_sessions.sql'), 'utf8')))
      expect((await s.db.execute<{ n: number }>(sql`select count(*)::int as n from reading_session`))[0]?.n).toBe(before)
    } finally {
      await s.drop()
    }
  })
})
