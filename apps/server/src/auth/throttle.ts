/** In-memory login-attempt counter per username (single server process per household). */
export class LoginThrottle {
  private readonly attempts = new Map<string, number[]>()

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Synchronously claims an attempt slot before any credential check is awaited, so concurrent
   * attempts see each other. Returns false (recording nothing) when the key is blocked.
   * A successful login calls `reset`.
   */
  attempt(key: string): boolean {
    this.prune()
    const recent = this.attempts.get(key) ?? []
    if (recent.length >= this.maxAttempts) return false
    this.attempts.set(key, [...recent, this.now()])
    return true
  }

  reset(key: string): void {
    this.attempts.delete(key)
  }

  /** Number of keys currently tracked (for tests). */
  get trackedKeys(): number {
    return this.attempts.size
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs
    for (const [key, times] of this.attempts) {
      const recent = times.filter((at) => at > cutoff)
      if (recent.length === 0) this.attempts.delete(key)
      else if (recent.length !== times.length) this.attempts.set(key, recent)
    }
  }
}
