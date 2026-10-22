import type { HardcoverClient, HttpClient } from '@mylib/connectors'
import type { ImageFetcher } from '../public-image'
import type { AssetStore, Db, OpsEnv, SecretBox, UserRecord } from '@mylib/db'
import type { JobQueue } from '@mylib/jobs'
import { sessionUserFromCookie } from '../auth/session-user'
import type { LoginThrottle } from '../auth/throttle'
import type { Config } from '../config'
import type { MaintenanceGate } from '../maintenance'
import type { RestoreRunner } from '../ops/restore-runner'

export interface AppDeps {
  db: Db
  config: Config
  /** maintenance for this process (restore, failed start-up) */
  gate: MaintenanceGate
  /** backups, restores and start-up (paths, key, version, pg tools) */
  ops: OpsEnv
  throttle: LoginThrottle
  now: () => Date
  /** seals/opens source credentials (APP_SECRET_KEY) */
  secrets: SecretBox
  /** enqueues work for apps/worker */
  jobs: JobQueue
  /** GET-only client for "Test connection" */
  http: HttpClient
  /** a picture from an address someone typed: public internet only (#100) */
  fetchImage: ImageFetcher
  /** covers and uploads on the mounted volume */
  assets: AssetStore
  /** runs one restore at a time in the background */
  restorer: RestoreRunner
  /** a Hardcover API client for a token (Admin/My account tests, link by URL) */
  hardcover: (token: string) => HardcoverClient
}

export interface Context extends AppDeps {
  user: UserRecord | null
  sessionId: string | null
  /** headers merged into the HTTP response (used for Set-Cookie) */
  resHeaders: Headers
}

export async function createContext(deps: AppDeps, req: Request, resHeaders: Headers): Promise<Context> {
  const { user, sessionId } = await sessionUserFromCookie(deps, req.headers.get('cookie'))
  return { ...deps, user, sessionId, resHeaders }
}
