import { cloudCopyBehind, copyToCloud, describeError, updateCloudStatus, type ResticRunner } from '@mylib/db'

/** How often the worker looks for a backup the cloud doesn't have yet (one an upgrade took, or a failed copy to retry). */
export const CLOUD_CHECK_EVERY_MS = 60 * 60_000

export interface CloudCopierDeps {
  backupDir: string
  /** null: no cloud copy is set up */
  restic: ResticRunner | null
  everyMs?: number
  log?: (message: string) => void
}

/**
 * #106: copies BACKUP_DIR to the cloud after each backup the worker makes, and hourly when the cloud is
 * behind. One copy at a time; a request during a copy runs once more after it. Never throws.
 */
export class CloudCopier {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private again = false
  private controller: AbortController | null = null
  private readonly log: (message: string) => void

  constructor(private readonly deps: CloudCopierDeps) {
    this.log = deps.log ?? ((message) => console.log(message))
  }

  async start(): Promise<void> {
    const configured = this.deps.restic !== null
    await updateCloudStatus(this.deps.backupDir, (s) => ({ ...s, configured })).catch((error: unknown) => this.log(`[cloud] could not write the cloud backup status: ${describeError(error)}`))
    if (!configured || this.timer !== null) return
    this.timer = setInterval(() => void this.requestIfBehind(), this.deps.everyMs ?? CLOUD_CHECK_EVERY_MS)
    void this.requestIfBehind()
  }

  /** Stops the timer and any copy in flight (restic is interrupted; the next start copies again). */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.again = false
    this.controller?.abort()
    await this.running
  }

  request(): Promise<void> {
    if (this.deps.restic === null || this.timer === null) return Promise.resolve()
    if (this.running !== null) {
      this.again = true
      return this.running
    }
    this.running = this.loop().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async requestIfBehind(): Promise<void> {
    if (this.running !== null) return
    try {
      if (await cloudCopyBehind(this.deps.backupDir)) await this.request()
    } catch (error) {
      this.log(`[cloud] could not check the cloud copy: ${describeError(error)}`)
    }
  }

  private async loop(): Promise<void> {
    const restic = this.deps.restic
    if (restic === null) return
    this.again = false
    do {
      const controller = new AbortController()
      this.controller = controller
      const result = await copyToCloud(this.deps.backupDir, restic, { signal: controller.signal })
      this.controller = null
      // stopped (a shutdown, a restore): stop() aborted this copy
      if (this.timer === null) return
      if (result.outcome === 'copied') this.log(`[cloud] copied ${result.file} (snapshot ${result.snapshot.slice(0, 8)}), verified${result.warning === null ? '' : `; warning: ${result.warning}`}`)
      else if (result.outcome === 'failed') this.log(`[cloud] copy failed: ${result.error}`)
    } while (this.takeAgain())
  }

  /** whether a request came in during the copy (and forget it) */
  private takeAgain(): boolean {
    const again = this.again
    this.again = false
    return again
  }
}
