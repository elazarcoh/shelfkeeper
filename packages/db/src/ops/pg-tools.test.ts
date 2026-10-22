import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, inject, it } from 'vitest'
import { createDb } from '../client'
import { containerPgTools, containerProcessMentions, createScratchDatabase, expectTreeKilled, hangingTool, installDdlHang, lingeringTool, tempDir, testPgTools, waitFor } from '../testing'
import { createEmptyDatabase, dropDatabase, withDatabase } from './database-admin'
import { createPgTools, PgToolError } from './pg-tools'

describe('PgTools', () => {
  const tools = testPgTools()

  it('dumps, lists and restores a database, Hebrew text included', async () => {
    const source = await createScratchDatabase('empty')
    try {
      await source.db.execute(sql`create table t (v text)`)
      await source.db.execute(sql`insert into t values ('שלום')`)
      const dump = path.join(tempDir('pgtools'), 'db.dump')
      await tools.dump(source.url, dump)
      expect(await tools.list(dump)).toContain('TABLE public t')

      const target = `${source.name}_restore`
      await createEmptyDatabase(source.url, target)
      await tools.restore(withDatabase(source.url, target), dump)
      const restored = createDb(withDatabase(source.url, target), { max: 1 })
      expect(await restored.db.execute(sql`select v from t`)).toEqual([{ v: 'שלום' }])
      await restored.close()
    } finally {
      await source.drop()
    }
  })

  it("leaves out an excluded table's rows but keeps the table", async () => {
    const source = await createScratchDatabase('empty')
    try {
      await source.db.execute(sql`create table keep_me (v int)`)
      await source.db.execute(sql`create table skip_rows (v int)`)
      await source.db.execute(sql`insert into keep_me values (1)`)
      await source.db.execute(sql`insert into skip_rows values (2)`)
      const dump = path.join(tempDir('pgtools'), 'db.dump')
      await tools.dump(source.url, dump, { excludeTableData: ['public.skip_rows'] })
      const target = `${source.name}_restore`
      await createEmptyDatabase(source.url, target)
      await tools.restore(withDatabase(source.url, target), dump)
      const restored = createDb(withDatabase(source.url, target), { max: 1 })
      expect(await restored.db.execute(sql`select (select count(*)::int from keep_me) as kept, (select count(*)::int from skip_rows) as skipped`)).toEqual([{ kept: 1, skipped: 0 }])
      await restored.close()
    } finally {
      await source.drop()
    }
  })

  it('reports an unreadable dump as a PgToolError', async () => {
    const bogus = path.join(tempDir('pgtools'), 'db.dump')
    writeFileSync(bogus, 'this is not a dump')
    let caught: unknown
    try {
      await tools.list(bogus)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PgToolError)
    expect((caught as PgToolError).kind).toBe('exit')
  })

  it('wraps a spawn error (binary not installed) as a PgToolError, without leaking the url or its password, and does not crash the process (R2)', async () => {
    // a prefix that is certainly not on PATH, on any machine: a deterministic ENOENT, unlike relying
    // on pg_restore itself being absent (which is only true on this dev machine, not necessarily CI)
    const bareTools = createPgTools({ prefix: ['mylib-no-such-binary'] })
    const dump = path.join(tempDir('pgtools'), 'db.dump')
    writeFileSync(dump, 'anything')
    const url = 'postgres://scratch_user:sup3r-secret@example.invalid:5432/scratchdb'
    let caught: unknown
    try {
      await bareTools.restore(url, dump)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PgToolError)
    expect((caught as PgToolError).kind).toBe('spawn')
    const message = (caught as Error).message
    expect(message).toMatch(/could not be started/)
    expect(message).not.toContain('sup3r-secret')
    expect(message).not.toContain(url)
  })

  it('reports the tool\'s own labeled error line, never a raw "Command was: <query>" tail (R19)', async () => {
    const fakeTool = path.join(tempDir('pgtools'), 'fake-tool.cjs')
    writeFileSync(
      fakeTool,
      [
        // drains stdin first, so the parent's write side never sees EPIPE before it can flush
        'process.stdin.resume()',
        'process.stdin.on(\'end\', () => {',
        '  process.stderr.write(\'pg_dump: error: query failed: ERROR: relation "secret_table" does not exist\\n\')',
        '  process.stderr.write(\'Command was: SELECT * FROM secret_table\\n\')',
        '  process.exitCode = 1',
        '})',
        '',
      ].join('\n'),
    )
    const fakeTools = createPgTools({ prefix: [process.execPath, fakeTool] })
    const dump = path.join(tempDir('pgtools'), 'db.dump')
    writeFileSync(dump, 'anything')
    let caught: unknown
    try {
      await fakeTools.list(dump)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PgToolError)
    const message = (caught as Error).message
    expect(message).toContain('pg_dump: error: query failed: ERROR: relation "secret_table" does not exist')
    expect(message).not.toContain('Command was')
  })

  it('reports a stdin/stdout piping failure (the output file already exists) rather than the exit-code message', async () => {
    const source = await createScratchDatabase('empty')
    try {
      const dump = path.join(tempDir('pgtools'), 'db.dump')
      writeFileSync(dump, 'already here')
      let caught: unknown
      try {
        await tools.dump(source.url, dump)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(PgToolError)
      expect((caught as PgToolError).kind).toBe('stdio')
      expect((caught as Error).message).toMatch(/EEXIST/)
    } finally {
      await source.drop()
    }
  })

  // Round 2, item 3: a genuinely missing input file must still be reported as an I/O failure -- the
  // R21 fix (letting the exit code decide on an early stdin close) must not swallow this into a false
  // success just because the tool also happens to exit non-zero.
  it('reports a missing stdin input file as a PgToolError (kind "stdio"), not a false success', async () => {
    const missing = path.join(tempDir('pgtools'), 'does-not-exist.dump')
    let caught: unknown
    try {
      await tools.list(missing)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PgToolError)
    expect((caught as PgToolError).kind).toBe('stdio')
    expect((caught as Error).message).toMatch(/could not read its input/)
  })

  // R21: a tool that stops reading stdin once it has what it needs (pg_restore --list reading only the
  // header, or --exit-on-error stopping at the first bad record) must not have that early close reported
  // as an I/O failure — the exit code is what actually decides.
  it('resolves when the tool reads only part of a large input and exits 0, instead of reporting a broken pipe', async () => {
    const fakeTool = path.join(tempDir('pgtools'), 'reads-a-bit-then-ok.cjs')
    writeFileSync(
      fakeTool,
      ['let received = 0', "process.stdin.on('data', (chunk) => {", '  received += chunk.length', '  if (received > 4096) process.exit(0)', '})', ''].join('\n'),
    )
    const fakeTools = createPgTools({ prefix: [process.execPath, fakeTool] })
    const dump = path.join(tempDir('pgtools'), 'big.dump')
    writeFileSync(dump, Buffer.alloc(8 * 1024 * 1024, 'x'))
    await expect(fakeTools.list(dump)).resolves.toBeDefined()
  })

  it('reports the exit-code failure (kind "exit"), not a broken pipe, when the tool reads only part of a large input then fails', async () => {
    const fakeTool = path.join(tempDir('pgtools'), 'reads-a-bit-then-fails.cjs')
    writeFileSync(
      fakeTool,
      [
        'let received = 0',
        "process.stdin.on('data', (chunk) => {",
        '  received += chunk.length',
        '  if (received > 4096) {',
        "    process.stderr.write('pg_restore: error: input file does not appear to be a valid archive\\n')",
        '    process.exit(1)',
        '  }',
        '})',
        '',
      ].join('\n'),
    )
    const fakeTools = createPgTools({ prefix: [process.execPath, fakeTool] })
    const dump = path.join(tempDir('pgtools'), 'big.dump')
    writeFileSync(dump, Buffer.alloc(8 * 1024 * 1024, 'x'))
    let caught: unknown
    try {
      await fakeTools.list(dump)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PgToolError)
    expect((caught as PgToolError).kind).toBe('exit')
    expect((caught as Error).message).toContain('pg_restore: error: input file does not appear to be a valid archive')
  })

  it('kills a run that outlives its time limit, together with the processes it started, and reports kind "timeout" (3d item 3)', async () => {
    const tool = hangingTool()
    const input = path.join(tempDir('pgtools'), 'input.dump')
    writeFileSync(input, 'not read')
    const hung = createPgTools({ prefix: tool.prefix, timeoutsMs: { list: 2_000 }, killGraceMs: 3_000 })
    const started = Date.now()
    const error: unknown = await hung.list(input).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: 'PgToolError', kind: 'timeout' })
    expect((error as Error).message).toBe('pg_restore did not finish within 2 s and was stopped')
    expect(Date.now() - started).toBeLessThan(10_000)
    await expectTreeKilled(tool)
  })

  it('stops a run when its signal aborts, reporting kind "aborted" (3d item 3)', async () => {
    const tool = hangingTool()
    const input = path.join(tempDir('pgtools'), 'input.dump')
    writeFileSync(input, 'not read')
    const hung = createPgTools({ prefix: tool.prefix, killGraceMs: 3_000 })
    const controller = new AbortController()
    const running = hung.list(input, { signal: controller.signal })
    await waitFor(() => Promise.resolve(tool.pids() !== null), 'the tool to start', undefined, 10_000)
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'PgToolError', kind: 'aborted' })
    await expectTreeKilled(tool)
  })

  it('never starts a tool whose signal is already aborted (3d item 3, review focus 3)', async () => {
    const tool = hangingTool()
    const hung = createPgTools({ prefix: tool.prefix })
    await expect(hung.list(path.join(tempDir('pgtools'), 'missing.dump'), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'PgToolError', kind: 'aborted' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(tool.pids()).toBeNull()
  })

  it('through the docker exec prefix: a timed-out pg_restore is stopped on our side at once, and ends inside the container once its database is dropped (3d item 3)', async () => {
    const s = await createScratchDatabase()
    const target = `${s.name}_hang`
    try {
      const dumpFile = path.join(tempDir('pgtools'), 'db.dump')
      await tools.dump(s.url, dumpFile)
      await createEmptyDatabase(s.url, target)
      await installDdlHang(withDatabase(s.url, target))
      const slow = containerPgTools(inject('pgContainerId'), { timeoutsMs: { restore: 2_000 } })
      const started = Date.now()
      await expect(slow.restore(withDatabase(s.url, target), dumpFile)).rejects.toMatchObject({ name: 'PgToolError', kind: 'timeout' })
      expect(Date.now() - started).toBeLessThan(15_000)
      // what restoreBackup's failure path does with `<live>_restore`
      await dropDatabase(s.url, target)
      await waitFor(() => Promise.resolve(!containerProcessMentions(target)), 'pg_restore inside the container to exit', undefined, 30_000)
    } finally {
      await s.drop()
    }
  })

  it('stops waiting when the tool has exited but a descendant still holds its stdout open: kind "timeout" within the limit plus grace (3d item 3, review fix)', async () => {
    const tool = lingeringTool()
    try {
      const input = path.join(tempDir('pgtools'), 'input.dump')
      writeFileSync(input, 'not read')
      const lingering = createPgTools({ prefix: tool.prefix, timeoutsMs: { list: 1_500 }, killGraceMs: 2_000 })
      const started = Date.now()
      const error: unknown = await lingering.list(input).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ name: 'PgToolError', kind: 'timeout' })
      expect((error as Error).message).toBe('pg_restore did not finish within 1.5 s and was stopped')
      expect(Date.now() - started).toBeLessThan(1_500 + 2_000 + 3_000)
      expect(tool.pids()).toHaveLength(2)
    } finally {
      tool.cleanup()
    }
  })
})
