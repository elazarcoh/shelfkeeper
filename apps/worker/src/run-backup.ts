import { describeError, OpsBusyError, runBackup, type OpsEnv } from '@mylib/db'
import type { BackupJobData } from '@mylib/jobs'

/** One scheduled or manual backup (spec §4). Never throws: a failure is recorded in backup_run and logged in one line. */
export async function runBackupJob(deps: { ops: OpsEnv; log?: (message: string) => void }, data: BackupJobData): Promise<'done' | 'busy' | 'failed'> {
  const log = deps.log ?? ((message: string) => console.log(message))
  try {
    const result = await runBackup(deps.ops, data.kind)
    log(`[backup] wrote ${result.name} (${result.sizeBytes} bytes)${result.pruned.length > 0 ? `, pruned ${result.pruned.length}` : ''}`)
    return 'done'
  } catch (error) {
    if (error instanceof OpsBusyError) {
      log('[backup] skipped: another backup or a restore is running')
      return 'busy'
    }
    log(`[backup] failed: ${describeError(error)}`)
    return 'failed'
  }
}
