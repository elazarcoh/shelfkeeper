import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

interface Mount {
  type?: string
  source?: string
  target?: string
  read_only?: boolean
  bind?: { create_host_path?: boolean }
}
interface Service {
  image?: string
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> }
  pull_policy?: string
  container_name?: string
  restart?: string
  networks?: string[]
  healthcheck?: unknown
  logging?: unknown
  volumes?: (string | Mount)[]
  ports?: string[]
  init?: boolean
  stop_grace_period?: string
  tmpfs?: string[]
}

const composeText = read('./compose.yaml')
const compose = parse(composeText) as {
  services: Record<string, Service>
  networks?: Record<string, { external?: boolean }>
}
const services = Object.entries(compose.services)

/** Extracts the body of the first `{ ... }` block that follows `marker` (balanced braces, one level of nesting is fine). */
function blockBody(text: string, marker: string): string {
  const start = text.indexOf(marker)
  expect(start, `block not found: ${marker}`).toBeGreaterThanOrEqual(0)
  const braceStart = text.indexOf('{', start)
  let depth = 1
  let i = braceStart + 1
  while (depth > 0) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    i++
  }
  return text.slice(braceStart + 1, i - 1)
}

describe('deploy/compose.yaml (spec §3)', () => {
  it('runs postgres:17, app and worker, with app and worker on one pinned image', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['app', 'db', 'worker'])
    expect(compose.services.db?.image).toBe('postgres:17')
    // a local name: nothing to keep in step with the release (the image reads its version from the checkout)
    expect(compose.services.app?.image).toBe('my-library:local')
    expect(compose.services.worker?.image).toBe(compose.services.app?.image)
  })

  it('builds the image on the Pi from the checked-out tag (Komodo), and never pulls it', () => {
    // app: built from the repo root (compose.yaml lives in deploy/), always built rather than pulled
    expect(compose.services.app?.build).toMatchObject({ context: '..', dockerfile: 'Dockerfile' })
    // no version setting: the image reads the tag of the checked-out commit (Dockerfile, deploy/git-version.sh)
    expect(compose.services.app?.build?.args?.APP_VERSION).toBeUndefined()
    expect(read('./compose.yaml')).not.toContain('IMAGE_TAG')
    const dockerfile = read('../Dockerfile')
    expect(dockerfile).toContain('COPY deploy/git-version.sh .gi[t] /src/')
    expect(dockerfile).toMatch(/^ENTRYPOINT \["my-library-entrypoint"\]$/m)
    expect(read('../.dockerignore')).toMatch(/^!\.git\/refs\/tags$/m)
    expect(compose.services.app?.pull_policy).toBe('build')
    // worker: reuses the image the app's build just produced; never pulls (nothing publishes it: the app's build is the only copy)
    expect(compose.services.worker?.build).toBeUndefined()
    expect(compose.services.worker?.pull_policy).toBe('never')
    // db: a public image, pulled as usual
    expect(compose.services.db?.build).toBeUndefined()
  })

  it('restarts every service unless stopped, health-checks it, and rotates its logs at 10 MB × 3', () => {
    for (const [name, service] of services) {
      expect(service.restart, name).toBe('unless-stopped')
      expect(service.healthcheck, name).toBeDefined()
      expect(service.logging, name).toEqual({ driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } })
    }
  })

  it('every host path is a bind mount that must already exist', () => {
    for (const [name, service] of services) {
      for (const volume of service.volumes ?? []) {
        expect(typeof volume, `${name}: use the long volume syntax`).toBe('object')
        const mount = volume as Mount
        expect(mount.type, `${name} ${String(mount.source)}`).toBe('bind')
        expect(mount.bind?.create_host_path, `${name} ${String(mount.source)}`).toBe(false)
      }
    }
  })

  it('never mounts /Media itself or its Media/Downloads subfolders', () => {
    for (const [, service] of services) {
      for (const volume of service.volumes ?? []) {
        const source = String((volume as Mount).source)
        expect(source).not.toMatch(/^\/Media$/)
        expect(source).not.toMatch(/\/Media\/(Media|Downloads)(\/|$)/)
      }
    }
  })

  it('stops gracefully: node behind an init, with grace for a restore or upgrade to finish (final fix 2)', () => {
    expect(compose.services.app?.init).toBe(true)
    expect(compose.services.app?.stop_grace_period).toBe('120s')
    expect(compose.services.worker?.init).toBe(true)
    expect(compose.services.worker?.stop_grace_period).toBe('60s')
    expect(compose.services.db?.stop_grace_period).toBe('60s')
  })

  it('keeps the worker heartbeat (/tmp) on a tmpfs, off the SD card (final fix 5)', () => {
    expect(compose.services.worker?.tmpfs).toEqual(['/tmp'])
    expect(composeText).toContain('/tmp/mylib-worker-alive')
  })

  it('requires DATA_DIR rather than defaulting to a relative path', () => {
    expect(composeText).not.toContain('${DATA_DIR:-')
    expect(composeText).toContain('${DATA_DIR:?')
  })

  it('joins the app to the external shared nginx network under a fixed name, and publishes its port on localhost only (Ruling R30)', () => {
    expect(compose.services.app?.container_name).toBe('my-library')
    expect(compose.services.app?.networks).toEqual(expect.arrayContaining(['shared', 'default']))
    expect(compose.networks?.shared).toEqual({ external: true })
    const ports = compose.services.app?.ports ?? []
    expect(ports).toHaveLength(1)
    expect(ports[0]).toMatch(/^127\.0\.0\.1:/)
  })

  it('documents every variable the stack uses in .env.example', () => {
    const used = new Set([...composeText.matchAll(/\$\{([A-Z_]+)/g)].map((m) => m[1]))
    const documented = new Set([...read('./.env.example').matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]))
    for (const name of used) expect(documented.has(name), name).toBe(true)
    for (const name of ['POSTGRES_PASSWORD', 'APP_SECRET_KEY', 'APP_PORT', 'DATA_DIR', 'BACKUP_DIR', 'PROTECTED_PATHS', 'BACKUP_SCHEDULE', 'TZ']) {
      expect(documented.has(name), name).toBe(true)
    }
  })

  it('keeps the durability settings on and the memory settings small in postgres.conf', () => {
    const conf = read('./postgres.conf')
    for (const line of [
      "listen_addresses = '*'",
      'fsync = on',
      'synchronous_commit = on',
      'full_page_writes = on',
      'shared_buffers = 128MB',
      'work_mem = 8MB',
      'maintenance_work_mem = 64MB',
      'checkpoint_timeout = 15min',
      'max_wal_size = 512MB',
      'wal_compression = on',
      'log_min_duration_statement = 1000',
    ]) {
      expect(conf).toContain(line)
    }
  })

  it('gives csv.import 300 s and backups.restore 600 s, each inside its own location block, proxied by container name', () => {
    const conf = read('./nginx/mylibrary.home.arpa.conf')

    const csv = blockBody(conf, 'location ~ ^/trpc/.*csv\\.import {')
    expect(csv).toContain('proxy_read_timeout 300s;')
    expect(csv).toContain('proxy_send_timeout 300s;')

    const restore = blockBody(conf, 'location ~ ^/trpc/.*backups\\.restore {')
    expect(restore).toContain('proxy_read_timeout 600s;')
    expect(restore).toContain('proxy_send_timeout 600s;')

    const root = blockBody(conf, 'location / {')
    expect(root).not.toContain('proxy_read_timeout')
    expect(root).not.toContain('proxy_send_timeout')

    for (const body of [csv, restore, root]) {
      expect(body).toContain('set $upstream my-library:3000;')
      expect(body).toContain('proxy_pass http://$upstream;')
    }

    expect(conf).not.toContain('127.0.0.1:8080')
    expect(conf).not.toMatch(/^\s*resolver\s/m)
    expect(conf).toContain('proxy_set_header Host $host;')
    expect(conf).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;')
  })

  it('builds the web app for BASE_PATH (default: served at the root)', () => {
    expect(compose.services.app?.build?.args?.BASE_PATH).toBe('${BASE_PATH:-/}')
    const dockerfile = read('../Dockerfile')
    // the web build reads it, and the server gets the same value at run time
    expect(dockerfile).toMatch(/^ARG BASE_PATH=\/$/m)
    expect(dockerfile).toMatch(/^ENV .*BASE_PATH=\$BASE_PATH/m)
  })

  it('has a sub-path example that keeps the /mylibrary prefix on every proxied request', () => {
    const conf = read('./nginx/mylibrary-subpath.locations')
    const root = blockBody(conf, 'location ^~ /mylibrary/ {')
    expect(root).toContain('set $upstream my-library:3000;')
    // a variable proxy_pass with no URI part passes the request URI through unchanged (prefix kept)
    const passes = [...conf.matchAll(/proxy_pass ([^;]+);/g)].map((m) => m[1])
    expect(passes.length).toBeGreaterThanOrEqual(5)
    for (const pass of passes) expect(pass).toBe('http://$upstream')
    expect(blockBody(conf, 'location ~ ^/mylibrary/trpc/.*csv\\.import {')).toContain('proxy_read_timeout 300s;')
    expect(blockBody(conf, 'location ~ ^/mylibrary/trpc/.*backups\\.restore {')).toContain('proxy_read_timeout 600s;')
    expect(blockBody(conf, 'location = /mylibrary/admin/backups/upload {')).toContain('client_max_body_size 0;')
    expect(blockBody(conf, 'location ^~ /mylibrary/admin/backups/file/ {')).toContain('proxy_buffering off;')
    expect(conf).not.toMatch(/^\s*(server|resolver)\s/m)
  })

  it('scopes client_max_body_size 0 to the upload and csv.import locations only, not the whole server', () => {
    const conf = read('./nginx/mylibrary.home.arpa.conf')
    const beforeFirstLocation = conf.slice(0, conf.indexOf('location'))
    expect(beforeFirstLocation).not.toContain('client_max_body_size')

    const csv = blockBody(conf, 'location ~ ^/trpc/.*csv\\.import {')
    expect(csv).toContain('client_max_body_size 0;')
    const upload = blockBody(conf, 'location = /admin/backups/upload {')
    expect(upload).toContain('client_max_body_size 0;')
    const root = blockBody(conf, 'location / {')
    expect(root).not.toContain('client_max_body_size')
  })
})

// the public snapshot has no workflows (.publicignore): nothing to check there
const hasWorkflows = existsSync(fileURLToPath(new URL('../.github/workflows', import.meta.url)))
const workflow = (file: string): unknown => (hasWorkflows ? parse(read(file)) : {})

describe.skipIf(!hasWorkflows)('.github/workflows (spec §3, #142)', () => {
  type Job = { needs?: string; if?: string; uses?: string; with?: Record<string, unknown>; permissions?: Record<string, string>; strategy?: { matrix: Record<string, unknown[]> }; steps?: { run?: string }[] }
  const release = workflow('../.github/workflows/release.yml') as { on: { push: { tags: string[] } }; jobs: Record<string, Job> }
  const checks = workflow('../.github/workflows/checks.yml') as {
    on: { pull_request: unknown; workflow_call: { inputs: Record<string, { default?: unknown }> } }
    permissions: Record<string, string>
    jobs: Record<string, Job>
  }
  const runs = (job: string) => checks.jobs[job]?.steps?.map((s) => s.run ?? '') ?? []

  it('a v-tag runs every check, e2e included; a PR runs the same checks but e2e', () => {
    expect(release.on.push.tags).toEqual(['v*.*.*'])
    expect(release.jobs.checks?.uses).toBe('./.github/workflows/checks.yml')
    expect(release.jobs.checks?.with).toEqual({ e2e: true })
    expect(checks.on.pull_request).toBeDefined()
    expect(checks.on.workflow_call.inputs.e2e?.default).toBe(false)
    expect(checks.jobs.e2e?.if).toContain('inputs.e2e')
    expect(runs('e2e')).toContain('pnpm e2e')
    expect(runs('static')).toEqual(expect.arrayContaining(['pnpm typecheck', 'pnpm lint']))
    // every unit test file runs in exactly one of the shards
    const shards = checks.jobs.unit?.strategy?.matrix.shard ?? []
    expect(runs('unit')).toContain(`pnpm exec vitest run --shard=\${{ matrix.shard }}/${shards.length}`)
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1))
  })

  it('publishes no image: the Pi builds its own', () => {
    expect(Object.keys(release.jobs).sort()).toEqual(['checks', 'release-branch'])
  })

  it('grants each job only the permissions it needs', () => {
    expect(checks.permissions).toEqual({ contents: 'read' })
    expect(release.jobs.checks?.permissions).toEqual({ contents: 'read' })
    expect(release.jobs['release-branch']?.permissions).toEqual({ contents: 'write' })
  })

  it('moves the branch the Pi follows to a release only after every check, only forward, never for a pre-release', () => {
    const job = release.jobs['release-branch']
    expect(job?.needs).toBe('checks')
    expect(job?.if).toContain("!contains(github.ref_name, '-')")
    const script = job?.steps?.map((s) => s.run ?? '').join('\n') ?? ''
    expect(script).toContain('git merge-base --is-ancestor FETCH_HEAD "$GITHUB_SHA"')
    // a plain push: refused rather than forced if the branch is somehow not behind
    expect(script).toContain('git push origin "$GITHUB_SHA:refs/heads/release"')
    expect(script).not.toMatch(/--force|\+\$GITHUB_SHA/)
  })
})
