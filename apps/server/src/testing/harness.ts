import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHardcoverClient, createHttpClient } from '@mylib/connectors'
import { absFixtureFetch, arrFixtureFetch, calibreFixtureFetch, COVER_PNG, hardcoverFixturePost, routeFetch, type HardcoverFixtures } from '@mylib/connectors/testing'
import { createFileAssetStore, createSecretBox, createSession, DEV_SECRET_KEY, type RestoreOptions, type UserRecord } from '@mylib/db'
import { seedUser, testOpsEnv, useTestDb } from '@mylib/db/testing'
import { err, ok, type UserRole } from '@mylib/domain'
import type { AbsPushJobData, BackupJobData, HardcoverJobData, SyncJobData } from '@mylib/jobs'
import { beforeEach } from 'vitest'
import { SESSION_COOKIE } from '../auth/cookies'
import { newSessionToken, sessionIdFromToken } from '../auth/session-token'
import { LoginThrottle } from '../auth/throttle'
import type { Config } from '../config'
import { MaintenanceGate } from '../maintenance'
import { RestoreRunner } from '../ops/restore-runner'
import { appRouter } from '../router'
import type { AppDeps } from '../trpc/context'
import { createCallerFactory } from '../trpc/init'
import { OPEN_LIBRARY_COVERS_TEST_URL, OPEN_LIBRARY_TEST_URL, openLibraryCoversFixtureFetch, openLibraryFixtureFetch, resetOpenLibraryFetches } from './openlibrary-fixture'
import { NLI_TEST_KEY, NLI_TEST_URL, nliFixtureFetch, resetNliFetches } from './nli-fixture'
import { resetSimaniaFetches, SIMANIA_TEST_URL, simaniaFixtureFetch } from './simania-fixture'

const createCaller = createCallerFactory(appRouter)

export const testConfig: Config = {
  databaseUrl: 'unused',
  port: 0,
  cookieSecure: false,
  webDist: null,
  migrationsDir: null,
  sessionTtlDays: 30,
  appSecretKey: DEV_SECRET_KEY,
  assetsDir: 'unused',
  appVersion: '0.4.0-test',
  backupDir: 'unused',
  backupScheduleDefault: '0 3 * * *',
  protectedPaths: [],
  hostDataDir: null,
  hostBackupDir: null,
  requireVolumeMarkers: false,
  basePath: '',
  hardcoverApiUrl: null,
  nliApiKey: NLI_TEST_KEY,
  nliApiUrl: NLI_TEST_URL,
}

/** A fake Audiobookshelf (Task 12 fixtures) answers at this URL in server tests. */
/** the one address the fake fetchImage answers */
export const COVER_URL_TEST = 'https://img.test/cover.png'
export const ABS_TEST_URL = 'http://abs.test'
export const CALIBRE_TEST_URL = 'http://calibre.test'
export const READARR_TEST_URL = 'http://readarr.test'

export function useServerHarness() {
  const t = useTestDb()
  let throttle = new LoginThrottle()
  beforeEach(() => {
    throttle = new LoginThrottle()
  })

  const gate = new MaintenanceGate()
  beforeEach(() => {
    gate.leave()
  })

  const enqueued: SyncJobData[] = []
  const coversEnqueued: string[] = []
  const backupsEnqueued: BackupJobData[] = []
  const hardcoverEnqueued: HardcoverJobData[] = []
  const absPushEnqueued: AbsPushJobData[] = []
  // tests: set `fixtures` to what the fake Hardcover knows; reset before each test
  const hardcover = { fixtures: { token: '' } as HardcoverFixtures, calls: [] as { query: string; variables: unknown }[] }
  const queue = { failWith: null as Error | null }
  const secrets = createSecretBox(DEV_SECRET_KEY)
  const assetsRoot = mkdtempSync(path.join(tmpdir(), 'mylib-assets-'))
  const backupRoot = mkdtempSync(path.join(tmpdir(), 'mylib-backups-'))
  // Ruling R6: a shared backup folder across a file's tests would make backup tests order-dependent.
  beforeEach(() => {
    rmSync(backupRoot, { recursive: true, force: true })
    mkdirSync(backupRoot, { recursive: true })
  })
  const assetStore = createFileAssetStore(assetsRoot)
  const ops = () => testOpsEnv(t.url, { assetsDir: assetsRoot, backupDir: backupRoot })
  const http = createHttpClient({
    fetch: routeFetch({
      [ABS_TEST_URL]: absFixtureFetch(ABS_TEST_URL),
      [CALIBRE_TEST_URL]: calibreFixtureFetch(CALIBRE_TEST_URL),
      [READARR_TEST_URL]: arrFixtureFetch(READARR_TEST_URL),
      [SIMANIA_TEST_URL]: simaniaFixtureFetch(),
      [OPEN_LIBRARY_TEST_URL]: openLibraryFixtureFetch(),
      [OPEN_LIBRARY_COVERS_TEST_URL]: openLibraryCoversFixtureFetch(COVER_PNG),
      [new URL(NLI_TEST_URL).origin]: nliFixtureFetch(),
    }),
  })
  beforeEach(() => {
    resetSimaniaFetches()
    resetNliFetches()
    resetOpenLibraryFetches()
    enqueued.length = 0
    coversEnqueued.length = 0
    backupsEnqueued.length = 0
    hardcoverEnqueued.length = 0
    absPushEnqueued.length = 0
    hardcover.fixtures = { token: '' }
    hardcover.calls.length = 0
    queue.failWith = null
  })

  // tests: arm a hook right before triggering a restore (fix round 1 — makes concurrency tests
  // deterministic instead of racing two calls); read fresh on every run, reset before each test.
  const restoreHooks: { current: RestoreOptions['hooks'] } = { current: undefined }
  beforeEach(() => {
    restoreHooks.current = undefined
  })

  let restorer: RestoreRunner | undefined
  const getRestorer = (): RestoreRunner => {
    restorer ??= new RestoreRunner({ ops: ops(), gate, db: t.db, workerPauseTimeoutMs: 0, hooks: () => restoreHooks.current })
    return restorer
  }

  // tests: pin the server clock (ctx.now); reset before each test
  const clock = { now: null as Date | null }
  beforeEach(() => {
    clock.now = null
  })

  const deps = (): AppDeps => ({
    db: t.db,
    config: testConfig,
    gate,
    ops: ops(),
    throttle,
    now: () => clock.now ?? new Date(),
    secrets,
    http,
    fetchImage: (url) => Promise.resolve(url === COVER_URL_TEST ? ok({ bytes: COVER_PNG, kind: { mime: 'image/png', ext: 'png' } }) : err('That address is not on the public internet')),
    assets: assetStore,
    hardcover: (token) => {
      const post = hardcoverFixturePost(hardcover.fixtures)
      // every client shares one log (the fixture post only logs its own calls)
      const logged: typeof post = Object.assign(
        (...args: Parameters<typeof post>) => {
          hardcover.calls.push(JSON.parse(args[1].body) as { query: string; variables: unknown })
          return post(...args)
        },
        { calls: post.calls },
      )
      return createHardcoverClient({ token, post: logged, sleep: () => Promise.resolve() })
    },
    restorer: getRestorer(),
    jobs: {
      enqueueSync: (data) => {
        if (queue.failWith !== null) return Promise.reject(queue.failWith)
        enqueued.push(data)
        return Promise.resolve()
      },
      enqueueCovers: (data) => {
        if (queue.failWith !== null) return Promise.reject(queue.failWith)
        coversEnqueued.push(data.sourceId)
        return Promise.resolve()
      },
      enqueueBackup: (data) => {
        if (queue.failWith !== null) return Promise.reject(queue.failWith)
        backupsEnqueued.push(data)
        return Promise.resolve()
      },
      enqueueHardcover: (data) => {
        if (queue.failWith !== null) return Promise.reject(queue.failWith)
        hardcoverEnqueued.push(data)
        return Promise.resolve()
      },
      enqueueAbsPush: (data) => {
        if (queue.failWith !== null) return Promise.reject(queue.failWith)
        absPushEnqueued.push(data)
        return Promise.resolve()
      },
    },
  })

  function call(user: UserRecord | null = null, sessionId: string | null = null, overrides: Partial<AppDeps> = {}) {
    const resHeaders = new Headers()
    return { api: createCaller({ ...deps(), ...overrides, user, sessionId, resHeaders }), resHeaders }
  }

  async function asNewUser(role: UserRole = 'member') {
    const user = await seedUser(t.db, { role })
    return { user, api: call(user).api }
  }

  async function signedInCookie(role: UserRole = 'member', opts: { expiresAt?: Date } = {}) {
    const user = await seedUser(t.db, { role })
    const token = newSessionToken()
    await createSession(t.db, { id: sessionIdFromToken(token), userId: user.id, expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000) })
    return { user, cookie: `${SESSION_COOKIE}=${token}` }
  }

  return {
    get db() {
      return t.db
    },
    deps,
    gate,
    ops,
    call,
    /** the server clock the next calls see (null = the real one) */
    clock,
    asNewUser,
    signedInCookie,
    enqueued,
    coversEnqueued,
    backupsEnqueued,
    hardcoverEnqueued,
    absPushEnqueued,
    /** the fake Hardcover: set `fixtures`; `calls` logs every request across clients (reset per test) */
    hardcover,
    restorer: getRestorer,
    restoreHooks,
    /** set `failWith` to make enqueueing reject (reset before each test) */
    queue,
  }
}
