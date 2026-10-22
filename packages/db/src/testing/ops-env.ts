import type { OpsEnv } from '../ops/env'
import { DEV_SECRET_KEY } from '../secrets'
import { tempDir, TEST_MIGRATIONS_FOLDER, testPgTools } from './ops'

/** Bytes the asset store accepts as a cover (it does not sniff; the covers job does). */
export const TEST_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

export function testOpsEnv(databaseUrl: string, overrides: Partial<OpsEnv> = {}): OpsEnv {
  return {
    databaseUrl,
    migrationsFolder: TEST_MIGRATIONS_FOLDER,
    backupDir: tempDir('backups'),
    assetsDir: tempDir('assets'),
    appSecretKey: DEV_SECRET_KEY,
    appVersion: '0.4.0-test',
    pgTools: testPgTools(),
    ...overrides,
  }
}
