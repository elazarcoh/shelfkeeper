import { compose } from './compose'

export default function globalSetup(): void {
  try {
    compose('up', '-d', '--build', '--wait')
  } catch (err) {
    // Playwright skips globalTeardown when globalSetup throws, so tear the stack down
    // ourselves here (best-effort) before rethrowing, or the next run conflicts on :18080.
    try {
      compose('down', '-v')
    } catch {
      // ignore: a failing cleanup must not mask the original error
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}
