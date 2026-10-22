import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { waitFor } from './crash'
import { tempDir } from './ops'

export interface HangingTool {
  /** a PgTools prefix: node, the script, and the file it records its pids in. The pg tool's own arguments follow and are ignored. */
  prefix: string[]
  /** [the tool's pid, its child's pid] once it has started; null before */
  pids(): number[] | null
}

/**
 * 3d item 3: a stand-in for pg_dump/pg_restore stuck on a stalled USB disk. It never exits, never reads
 * stdin, never writes stdout, and has started a child of its own, so a test can check that the whole
 * process tree is killed, not just the direct child. It records its pids atomically (temp file, then
 * rename), so `pids()` never sees a half-written file.
 */
export function hangingTool(): HangingTool {
  const dir = tempDir('hanging-tool')
  const script = path.join(dir, 'never-exits.cjs')
  const pidsFile = path.join(dir, 'pids.json')
  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync, renameSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "writeFileSync(process.argv[2] + '.tmp', JSON.stringify([process.pid, child.pid]))",
      "renameSync(process.argv[2] + '.tmp', process.argv[2])",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  return {
    prefix: [process.execPath, script, pidsFile],
    pids: () => (existsSync(pidsFile) ? (JSON.parse(readFileSync(pidsFile, 'utf8')) as number[]) : null),
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // EPERM: it exists, we just may not signal it
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  // kill(pid, 0) also succeeds on a zombie (dead, not yet reaped, e.g. reparented to a PID 1 that does not reap)
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // "pid (comm) S ...": comm may contain spaces and parentheses, so read the state after the last ")"
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 3d item 3 (review fix): a stand-in for a tool that exits while a descendant it started still holds its
 * stdout open. Its pids are [the tool's, the descendant's]; the tool itself is gone by the time they are
 * recorded. `cleanup()` kills the descendant, which nothing else will.
 */
export function lingeringTool(): HangingTool & { cleanup(): void } {
  const dir = tempDir('lingering-tool')
  const script = path.join(dir, 'exits-leaving-a-child.cjs')
  const pidsFile = path.join(dir, 'pids.json')
  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync, renameSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true })",
      "writeFileSync(process.argv[2] + '.tmp', JSON.stringify([process.pid, child.pid]))",
      "renameSync(process.argv[2] + '.tmp', process.argv[2])",
      'child.unref()',
      'process.exit(0)',
      '',
    ].join('\n'),
  )
  const pids = (): number[] | null => (existsSync(pidsFile) ? (JSON.parse(readFileSync(pidsFile, 'utf8')) as number[]) : null)
  return {
    prefix: [process.execPath, script, pidsFile],
    pids,
    cleanup: () => {
      const descendant = pids()?.[1]
      if (descendant === undefined) return
      try {
        process.kill(descendant, 'SIGKILL')
      } catch {
        // already gone
      }
    },
  }
}

/** Asserts the hanging tool started (its pids list is [tool, child]) and that both are now gone. */
export async function expectTreeKilled(tool: HangingTool): Promise<void> {
  const pids = tool.pids()
  if (pids?.length !== 2) throw new Error(`expected the hanging tool to have recorded 2 pids, got ${JSON.stringify(pids)}`)
  await waitFor(() => Promise.resolve(pids.every((pid) => !isRunning(pid))), 'the tool and its child to be killed', undefined, 10_000)
}
