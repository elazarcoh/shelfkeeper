# Developing Shelfkeeper

[← Back to the README](../README.md)

## Develop

Requirements: Node 22+, pnpm 10 (`corepack enable`), Docker.

```sh
pnpm install
pnpm db:up          # Postgres on localhost:5433
pnpm dev            # API on :3000, web on :5173 (proxying /trpc)
pnpm dev:seed-demo  # once, after creating the first admin: fake books, history and two members (localhost only)
pnpm check          # typecheck + lint + unit/integration tests (Testcontainers)
pnpm e2e            # Playwright against a throwaway compose stack on :18080
pnpm db:generate    # new migration after changing packages/db/src/schema
```

The README's screenshots (`docs/images/`) show this demo household, never real data: seed an empty database with `pnpm dev:seed-demo`, make one backup (so no warning banner shows), and capture at 1440×900 for desktop and 390×844 at 2× for the phone.

`patches/postgres@3.4.9.patch` fixes two upstream bugs in the `postgres` driver, both triggered by a dropped connection:
- a query sent on the dead connection (a transaction's ROLLBACK) was written to a null socket, and the uncaught error crashed the process;
- the connection kept the dropped query and its error, so a refused reconnect looped at once, forever, and a graceful `end()` never settled.

pnpm applies the patch on `pnpm install`. pnpm refuses an unused patch, so `pnpm install` fails loudly once `postgres` moves past 3.4.9, and a version bump cannot drop the patch silently. After such a bump, run `packages/db/src/driver.test.ts` against the new version without the patch. If it passes, delete the patch and its `patchedDependencies` entry in `pnpm-workspace.yaml`. If not, port the patch to the new version.

Dev Audiobookshelf (optional):

```sh
pnpm dev:seed-audiobooks -- --count 3   # copies 3 small book folders from Z:\Media\Audiobooks (read-only) into dev-data/
pnpm dev:abs                           # Audiobookshelf on http://localhost:13378
```

First time only, in Audiobookshelf: create the root user; add a library of type *Books* with the folder `/audiobooks` and let it scan; copy your user's API token. Then in Shelfkeeper (`pnpm dev`): Admin → Sources → Add source with `http://localhost:13378` and that token.

Live connector check: `ABS_URL=http://localhost:13378 ABS_TOKEN=<token> pnpm vitest run packages/connectors/src/audiobookshelf/live.test.ts`.

## Dev sources

All sample data is **copied** from the media drive into `dev-data/` (git-ignored). The seed
scripts refuse to write under `Z:` and never change a file there.

```sh
pnpm dev:seed-audiobooks -- --from "Z:\Media\Audiobooks" --count 3   # Audiobookshelf / Chaptarr
pnpm dev:seed-ebooks -- --from "Z:\" --count 6 --max-mb 30           # Calibre / Readarr / Chaptarr
```

**Calibre** (no manual setup): `pnpm dev:calibre`, then add a source in Admin → Sources:
kind Calibre, URL `http://localhost:18083`, no username, word count column `#words`. The first start
imports `dev-data/ebooks` and creates the `#words` column (empty — fill it with the Count Pages
plugin in a desktop Calibre if you want word counts). To re-import, stop it and delete `dev-data/calibre`.

**Readarr** (one-time, in its web UI at http://localhost:8787):
1. Settings → Media Management → Root Folders → add `/books`.
2. Library → Import → `/books` → match the copied books → Import (this creates the book records and
   links their files).
3. Add one more book by search **without** a file and keep it monitored — it shows up as a wanted book.
4. Settings → General → Security → copy the API key.
5. Admin → Sources: kind Readarr, URL `http://localhost:8787`, API key from step 4.

**Chaptarr** (one-time, http://localhost:8789): the same steps with root folders `/books` and
`/audiobooks`; source kind Chaptarr, URL `http://localhost:8789`.

**Live smoke tests** (skipped unless the variables are set):

```sh
CALIBRE_URL=http://localhost:18083 CALIBRE_WORDS=#words pnpm vitest run packages/connectors/src/calibre/live.test.ts
ARR_KIND=readarr ARR_URL=http://localhost:8787 ARR_KEY=… pnpm vitest run packages/connectors/src/arr/live.test.ts
ARR_KIND=chaptarr ARR_URL=http://localhost:8789 ARR_KEY=… pnpm vitest run packages/connectors/src/arr/live.test.ts
```

Layout and libraries: see the README's "Stack".


## Testing: concurrency and idempotency

Each situation has a named test:

| Situation | Test |
|---|---|
| Two backups at once | `packages/db/src/ops/backups.test.ts` › refuses a second backup while one runs |
| A backup and a restore at once | `packages/db/src/ops/restore.test.ts` › refuses a restore while a backup runs |
| Two restores at once | `apps/server/src/routers/backups.test.ts` › refuses a second restore while one runs |
| Two start-ups migrating at once | `packages/db/src/ops/startup.test.ts` › two start-ups at once migrate once |
| A double "Back up now" | `packages/jobs/src/index.test.ts` › keeps at most one queued backup per kind |
| Sync twice → same state | `packages/db/src/repos/sync.test.ts` › is idempotent: re-running changes nothing; `apps/worker/src/crash.test.ts` › a sync killed midway … ends where one clean sync ends |
| The same CSV import sent twice | `packages/db/src/repos/csv-import.test.ts` › runs an import once …; › creates exactly one source when the same import arrives twice at once |
| One Inbox item resolved twice at once | `packages/db/src/repos/inbox.test.ts` › handles each proposal once, even when two requests race |
| The same read accepted twice | `packages/db/src/repos/csv-import.test.ts` › does not record the same read twice when a file is imported again |
| A backup that loses its lock | `packages/db/src/ops/backups.test.ts` › a backup whose lock session is lost stops before renaming its zip into place |
| A restore that loses its lock | `packages/db/src/ops/restore.test.ts` › never swaps when its lock session was lost mid-restore …; › a lock session that still holds the lock for ~2 s after the loss does not strand maintenance … |
| The database drops mid-upgrade | `packages/db/src/ops/startup.test.ts` › a connection dropped mid-migration is not a verdict …; › keeps one pre-upgrade backup across repeated losses; `apps/server/src/start-up.test.ts` › loses the database in the middle of preparing it … |
| The driver after a dropped connection | `packages/db/src/driver.test.ts` › postgres.js after a connection drops mid-query; › postgres.js when a socket closes while connecting (fake sockets) |
| Upload a backup, then restore it | `e2e/tests/zzzz-upload-restore.spec.ts` › an admin uploads a downloaded backup and restores it … |

Migrations are checked by `packages/db/src/ops/migration-rules.test.ts`:
- they are generated by drizzle-kit and additive only;
- `DROP`, `RENAME` and type changes need an allow-list entry with the two-release plan;
- plain index builds are fine at household scale.

