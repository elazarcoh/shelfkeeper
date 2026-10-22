import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import postgres from 'postgres'
import { withDatabase } from '../ops/database-admin'
import { sleep } from '../ops/fs-utils'

export interface ChildRun {
  readonly process: ChildProcess
  output(): string
}

/**
 * Runs a TypeScript file in its own Node process, so a test can SIGKILL it mid-write (on Windows,
 * TerminateProcess: just as abrupt). tsx is resolved from `cwd`, which must be a package listing tsx
 * (packages/db or apps/worker). `node --import tsx` keeps it one process, where the tsx CLI would spawn
 * a grandchild that survives the kill.
 */
export function startChild(script: string, env: Record<string, string>, cwd: string): ChildRun {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-20_000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return { process: child, output: () => output }
}

export async function killHard(run: ChildRun): Promise<void> {
  if (run.process.exitCode !== null || run.process.signalCode !== null) return
  const exited = once(run.process, 'exit')
  run.process.kill('SIGKILL')
  await exited
}

export async function waitFor(check: () => Promise<boolean>, what: string, run?: ChildRun, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (run !== undefined && run.process.exitCode !== null) throw new Error(`The child exited before ${what}:\n${run.output()}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${run === undefined ? '' : `:\n${run.output()}`}`)
    await sleep(50)
  }
}

/** postgres-js sends URL query parameters as startup parameters, so the child's sessions carry this name. */
export function withApplicationName(url: string, name: string): string {
  const u = new URL(url)
  u.searchParams.set('application_name', name)
  return u.toString()
}

async function onAdmin<T>(url: string, fn: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    return await fn(admin)
  } finally {
    await admin.end()
  }
}

/**
 * Postgres ends a dead client's session only when it next touches the socket (a statement in flight
 * runs on). A restarted app would not wait for that, and neither does the test.
 */
export async function endSessions(url: string, applicationName: string): Promise<void> {
  await onAdmin(url, async (admin) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await admin`select pid from pg_stat_activity where application_name = ${applicationName}`
      if (rows.length === 0) return
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${applicationName}`
      await sleep(50)
    }
    throw new Error(`The sessions of ${applicationName} did not end`)
  })
}

/** True while a session of `applicationName` has had a transaction open for at least `minMs`. */
export async function openTransactionFor(url: string, applicationName: string, minMs = 200): Promise<boolean> {
  return onAdmin(url, async (admin) => {
    const rows = await admin`select 1 from pg_stat_activity where application_name = ${applicationName} and xact_start < now() - make_interval(secs => ${minMs / 1000})`
    return rows.length > 0
  })
}

export async function runningQuery(url: string, applicationName: string, fragment: string): Promise<boolean> {
  return onAdmin(url, async (admin) => {
    const rows = await admin`select 1 from pg_stat_activity where application_name = ${applicationName} and state = 'active' and query ilike ${`%${fragment}%`}`
    return rows.length > 0
  })
}
