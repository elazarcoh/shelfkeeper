import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { describeError } from './fs-utils'

export type PgToolName = 'dump' | 'list' | 'restore'

/**
 * 3d item 3 (decision 1): how long one run may take before it is killed. Sized for the Pi 4 writing to
 * a USB HDD:
 * - Covers are files, not rows, so a large household database dumps to well under 200 MB, which is
 *   under 20 s of `-Fc` compression on one core.
 * - A spun-down disk adds about 30 s; a healthy dump is under 2 min.
 * - A restore rebuilds every index in one transaction (allow 5x); `--list` reads the table of contents only.
 * - About 15x a healthy run, and well under the backup job's pg-boss expiry (3 h).
 */
export const DEFAULT_PG_TOOL_TIMEOUTS_MS: Readonly<Record<PgToolName, number>> = {
  dump: 30 * 60_000,
  list: 10 * 60_000,
  restore: 60 * 60_000,
}

/** After a kill, how long a run waits for the child and its pipes to wind down before it stops waiting for them. */
export const PG_TOOL_KILL_GRACE_MS = 5_000

/** pg_dump / pg_restore from the PostgreSQL 17 client tools in the image (spec §3). */
export interface PgTools {
  /**
   * `pg_dump -Fc` of the whole database into `outFile`, which must not exist yet (opened the
   * equivalent of `wx`, so an existing file is an error rather than silently overwritten). Callers
   * write to a temp path of their own and rename it into place afterwards, the same as any other
   * durable write in this codebase.
   */
  dump(databaseUrl: string, outFile: string, options?: { excludeTableData?: readonly string[]; signal?: AbortSignal }): Promise<void>
  /** `pg_restore --list`: the table of contents; throws when the dump can't be read */
  list(dumpFile: string, options?: { signal?: AbortSignal }): Promise<string>
  /** into an existing empty database, in one transaction, stopping at the first error */
  restore(databaseUrl: string, dumpFile: string, options?: { signal?: AbortSignal }): Promise<void>
}

export interface PgToolsOptions {
  /** run the tools through this command (tests: `docker exec -i -e PGPASSWORD <container>`) */
  prefix?: readonly string[]
  /** the connection URL as the tools see it (tests: the container's own localhost:5432) */
  rewriteUrl?: (url: string) => string
  /** per-tool limits (default DEFAULT_PG_TOOL_TIMEOUTS_MS); tests pass a few seconds */
  timeoutsMs?: Partial<Record<PgToolName, number>>
  /** default PG_TOOL_KILL_GRACE_MS */
  killGraceMs?: number
}

/**
 * `kind` distinguishes a genuine tool failure (the tool ran and rejected its input: `'exit'`) from a
 * failure to even run it (`'spawn'`: binary missing/ENOENT) or to pipe its stdin/stdout (`'stdio'`).
 * Callers that map a specific tool failure to a domain verdict (e.g. "this dump is damaged") must
 * check `kind === 'exit'` first, so a missing binary or a broken pipe is never mistaken for that verdict.
 * `'timeout'`: the run outlived its limit and was killed (3d item 3). `'aborted'`: the caller's signal stopped it,
 * or it was never started because the signal had already fired (a lost ops lock, 3d item 4).
 */
export class PgToolError extends Error {
  override readonly name = 'PgToolError'
  constructor(
    message: string,
    readonly kind: 'spawn' | 'stdio' | 'exit' | 'timeout' | 'aborted',
  ) {
    super(message)
  }
}

/** The password travels in PGPASSWORD, never on the command line (where `ps` would show it). */
function connectionOf(url: string, rewrite: (url: string) => string): { dbArg: string; password: string } {
  const u = new URL(rewrite(url))
  const password = decodeURIComponent(u.password)
  u.password = ''
  return { dbArg: u.toString(), password }
}

interface RunIo {
  password?: string
  stdinFile?: string
  stdoutFile?: string
  timeoutMs: number
  killGraceMs: number
  signal?: AbortSignal
}

const POSIX = process.platform !== 'win32'

/**
 * 3d item 3 (decision 2): SIGKILL the tool and everything it started. On POSIX the child leads its own
 * process group (spawned `detached`), so one signal to the group also reaches a `docker exec` client's
 * own children. On Windows `taskkill /T /F` walks the tree. Never throws: a child that already exited is fine.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (POSIX) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
}

function describeLimit(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  if (ms >= 1000) return `${ms / 1000} s`
  return `${ms} ms`
}

/** Env vars the OS or the Postgres client tools need just to run at all, never our own app's secrets. */
const PASSTHROUGH_ENV_KEYS = ['PATH', 'SystemRoot', 'ComSpec', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LANGUAGE'] as const

/** A minimal, explicit environment for the child (never all of `process.env`, which may hold unrelated app secrets). */
function childEnv(password: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PG') && value !== undefined) env[key] = value
  }
  if (password !== undefined) env.PGPASSWORD = password
  return env
}

/** R19: never echo a raw stderr tail (it can be a "Command was: <query>" line, i.e. table/row data) — only the tool's own labeled error line, if it printed one. */
function lastToolErrorLine(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line !== undefined && (line.startsWith('pg_dump:') || line.startsWith('pg_restore:'))) return line
  }
  return undefined
}

/**
 * R21: `pg_restore --list` (and `--exit-on-error` on the first bad record) stops reading stdin once it
 * has what it needs, closing its end of the pipe while our write side may still have a multi-MB dump
 * queued up. That surfaces here as EPIPE (a write after the reader closed) or ERR_STREAM_PREMATURE_CLOSE
 * (pipeline sees the destination end before the source finished) on POSIX -- or, on Windows (verified
 * against a real multi-MB dump piped through `docker exec`), as libuv's own `EOF` on the `write` syscall,
 * not `EPIPE`. None of these are a real I/O failure.
 */
function isEarlyStdinClose(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false
  const err = reason as NodeJS.ErrnoException & { syscall?: string }
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') return true
  return err.code === 'EOF' && err.syscall === 'write'
}

async function run(command: readonly string[], io: RunIo): Promise<string> {
  const [cmd, ...args] = command
  if (cmd === undefined) throw new Error('empty command')
  const tool = command.find((part) => part.startsWith('pg_')) ?? cmd
  if (io.signal?.aborted === true) throw new PgToolError(`${tool} was not started: the operation was cancelled`, 'aborted')
  const env = childEnv(io.password)
  // detached on POSIX: the child leads its own process group so killTree can signal the whole tree. A terminal
  // Ctrl-C therefore no longer reaches pg tools in dev, which is intended (the parent kills the group).
  const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: POSIX })
  // R2: a broken pipe on these streams (e.g. the process never actually started) must never become
  // an unhandled 'error' event on its own; the promises below are what report the failure.
  child.stdin.on('error', () => undefined)
  child.stdout.on('error', () => undefined)
  child.stderr.on('error', () => undefined)

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
  // a box rather than `let`s: see the Global Constraints note on TS narrowing
  const stop: { reason: 'timeout' | 'aborted' | null; exited: boolean } = { reason: null, exited: false }
  child.once('exit', () => {
    stop.exited = true
  })
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let giveUp: () => void = () => undefined
  const gaveUp = new Promise<'gave-up'>((resolve) => {
    giveUp = () => resolve('gave-up')
  })
  const halt = (reason: 'timeout' | 'aborted'): void => {
    if (stop.reason !== null) return
    stop.reason = reason
    // after the exit there is nothing left to kill, but a descendant or a stalled write may still hold our pipes
    if (!stop.exited) killTree(child)
    // settle our ends of the pipes now: a killed child's pipes otherwise close only once every process holding them is gone
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    // a child stuck in uninterruptible I/O (a stalled USB disk) may never report its exit: stop waiting for it
    graceTimer = setTimeout(giveUp, io.killGraceMs)
  }
  const timer = setTimeout(() => halt('timeout'), io.timeoutMs)
  const onAbort = (): void => halt('aborted')
  io.signal?.addEventListener('abort', onAbort, { once: true })
  let input: Promise<void>
  if (io.stdinFile === undefined) {
    child.stdin.end()
    input = Promise.resolve()
  } else {
    input = pipeline(createReadStream(io.stdinFile), child.stdin)
  }
  let stdout = ''
  const output =
    io.stdoutFile === undefined
      ? (async () => {
          child.stdout.setEncoding('utf8')
          for await (const chunk of child.stdout) stdout += String(chunk)
        })()
      : pipeline(child.stdout, createWriteStream(io.stdoutFile, { flags: 'wx' }))
  // R2: fold the process exit into the same allSettled as the stdin/stdout piping. A spawn error
  // (binary not installed, ENOENT) rejects `exited`; awaiting it separately afterwards, as a plain
  // `await`, still leaves a window where Node flags it as an unhandled rejection before we get here.
  try {
    const settled = await Promise.race([Promise.allSettled([input, output, exited]), gaveUp])
    if (stop.reason === 'timeout') throw new PgToolError(`${tool} did not finish within ${describeLimit(io.timeoutMs)} and was stopped`, 'timeout')
    if (stop.reason === 'aborted') throw new PgToolError(`${tool} was stopped: the operation was cancelled`, 'aborted')
    // defensive: the give-up timer is only armed by halt, which has already set a reason above
    if (settled === 'gave-up') throw new PgToolError(`${tool} was stopped: the operation was cancelled`, 'aborted')
    const [inResult, outResult, exitResult] = settled
    if (exitResult.status === 'rejected') {
      throw new PgToolError(`${tool} could not be started: ${describeError(exitResult.reason)}`, 'spawn')
    }
    const code = exitResult.value
    const throwExitError = (): never => {
      const line = lastToolErrorLine(stderr)
      throw new PgToolError(line === undefined ? `${tool} failed (exit ${code})` : `${tool} failed (exit ${code}): ${line}`, 'exit')
    }
    // A stream I/O failure (the output file already exists, ENOENT/ENOSPC, …) is the real cause even
    // though the tool then also exits non-zero once its pipe breaks: report the cause, not the exit code.
    if (outResult.status === 'rejected') {
      throw new PgToolError(`${tool} could not write its output: ${describeError(outResult.reason)}`, 'stdio')
    }
    if (inResult.status === 'rejected') {
      if (isEarlyStdinClose(inResult.reason)) {
        // R21: the tool stopped reading on its own; the exit code is the only thing that decides
        // success or failure here, exactly as it would if it had read the whole input.
        if (code !== 0) throwExitError()
      } else {
        throw new PgToolError(`${tool} could not read its input: ${describeError(inResult.reason)}`, 'stdio')
      }
    } else if (code !== 0) {
      throwExitError()
    }
    return stdout
  } finally {
    clearTimeout(timer)
    clearTimeout(graceTimer)
    io.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Streams through stdin/stdout in production and in tests alike (plan deviation 23). A custom-format
 * dump read from a pipe restores fine in one ordered pass, which is the only kind of restore we do.
 */
export function createPgTools(options: PgToolsOptions = {}): PgTools {
  const prefix = options.prefix ?? []
  const rewrite = options.rewriteUrl ?? ((url: string) => url)
  const timeouts = { ...DEFAULT_PG_TOOL_TIMEOUTS_MS, ...options.timeoutsMs }
  const killGraceMs = options.killGraceMs ?? PG_TOOL_KILL_GRACE_MS
  const control = (name: PgToolName, signal: AbortSignal | undefined) => ({ timeoutMs: timeouts[name], killGraceMs, ...(signal === undefined ? {} : { signal }) })
  return {
    async dump(databaseUrl, outFile, dumpOptions = {}) {
      const { dbArg, password } = connectionOf(databaseUrl, rewrite)
      const exclude = (dumpOptions.excludeTableData ?? []).map((table) => `--exclude-table-data=${table}`)
      await run([...prefix, 'pg_dump', '--format=custom', '--no-owner', '--no-privileges', ...exclude, `--dbname=${dbArg}`], {
        password,
        stdoutFile: outFile,
        ...control('dump', dumpOptions.signal),
      })
    },
    async list(dumpFile, listOptions = {}) {
      return run([...prefix, 'pg_restore', '--list'], { stdinFile: dumpFile, ...control('list', listOptions.signal) })
    },
    async restore(databaseUrl, dumpFile, restoreOptions = {}) {
      const { dbArg, password } = connectionOf(databaseUrl, rewrite)
      await run([...prefix, 'pg_restore', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${dbArg}`], {
        password,
        stdinFile: dumpFile,
        ...control('restore', restoreOptions.signal),
      })
    },
  }
}
