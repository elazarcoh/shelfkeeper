# My Library

A self-hosted household library: one catalog of books with their physical, ebook and audiobook editions, personal libraries built from sets, per-person visibility, reading sessions with a daily check-in, optional reading progress (page, audiobook time or ebook %, shown on Home and counted in stats), derived stats and goals, series tracking, loans, household wishlists, a household activity feed, and syncs books from Audiobookshelf, a CSV reading log or a photo of a shelf through a review Inbox.

A personal project, built for one household and shared as is: free to use, change and share under the MIT license (see License). No support, and no promise of updates.

Not yet: stats filters by tag, author or format, and week-by-week granularity (stats are by year and month).

## Stack

TypeScript end to end, in a pnpm workspace (Node 22+, pnpm 10).

| Layer | What |
|---|---|
| Web (`apps/web`) | React 19, Vite 7, TanStack Router + Query, tRPC client, Tailwind CSS 4, shadcn/ui (Radix), lucide icons, sonner toasts, dnd-kit (drag to reorder), cmdk (command palette), PWA (vite-plugin-pwa), barcode-detector + zxing-wasm (ISBN barcodes where the browser has no reader of its own) |
| API (`apps/server`) | Hono on Node, tRPC 11 with superjson, bundled with tsup |
| Worker (`apps/worker`) | Source syncs and scheduled jobs on pg-boss 12 |
| Domain (`packages/domain`) | Pure Zod 4 schemas and rules |
| Data (`packages/db`) | PostgreSQL 17, Drizzle ORM + drizzle-kit migrations, postgres.js driver (patched, see Develop); backups as zip (yazl/yauzl) |
| Jobs (`packages/jobs`) | pg-boss queues, shared by the API and the worker |
| Connectors (`packages/connectors`) | Audiobookshelf, Calibre, Readarr, Chaptarr clients; Hardcover (GraphQL) client, Open Library work lookup |
| Tests | Vitest, Testcontainers (real Postgres), fast-check, Playwright e2e |
| Tooling | ESLint 9 + typescript-eslint (also enforces import boundaries), TypeScript 5.9 |
| Deploy | One Docker image (app + worker) that names its release from the checked-out git tag, Docker Compose, GitHub Actions (checks on every PR; on a tag the checks plus e2e, side by side, then the `release` branch moves), Komodo on a Raspberry Pi behind nginx (`docs/deploy-pi.md`); restic (in the image) copies backups to Backblaze B2; a public one-commit-per-release snapshot (`scripts/publish-public.sh`, minus `.publicignore`) |

Layering: `packages/domain` → `packages/db` (all per-user queries go through `UserScope`) → `apps/server` → `apps/web`. Import boundaries are enforced by eslint.

## Run it (Docker Compose)

```sh
cp .env.example .env        # set POSTGRES_PASSWORD and APP_SECRET_KEY (the file shows how to generate it)
docker compose up -d --build
```

Keep `APP_SECRET_KEY` safe: it encrypts source API tokens. If the key changes, re-enter each source's API token in Admin → Sources.

Compose runs three services: `db`, `app` (web + API) and `worker` (source syncs and schedules).

Open `http://<server>:8080`. The first visit creates the admin account; the admin then adds household members (Admin → New person), optionally with a PIN for quick sign-in.

Serving over HTTPS behind a reverse proxy? Set `COOKIE_SECURE=true`.

This compose file keeps everything in Docker volumes, which is fine for trying the app. For a long-lived install, see "Running on a server" below.

**Backups:** Admin → Backups. A verified backup is written every night (03:00 in `TZ` by default) into `BACKUP_DIR`, and before every upgrade and every restore. Optionally the worker also keeps an encrypted copy in Backblaze B2 (see "Cloud backup").

## Sources

Admin → Sources → **Add source** connects an Audiobookshelf server (URL + an API token from Audiobookshelf → Settings → Users → your user). My Library only ever *reads* from it. **Sync now** (or a schedule) brings its books into the **Inbox**, where you decide for each one: add it as an edition of a book you have, link it to an existing copy, create a new book, or ignore it. Books that later disappear from Audiobookshelf are marked "no longer have it" (never deleted), and come back if the file does. When two sources read the same files (Audiobookshelf and Chaptarr on one folder, mounted at different paths), a book's folder within its library root ties them together: the second source's copy of the same format links to the first one's copy by itself, without an Inbox step. Every sync is listed under Admin → Jobs, with a Re-run button.

## Reading progress

Optional. In the daily check-in, type where you are (a page, a time, or a percentage for an ebook) and the button becomes "Still going · page …"; leave it empty and nothing changes. On a book's page, **Update progress** adds or corrects an update for any day of the read. Progress fills Home's bar under the cover, and the stats count the reading on the days it happened rather than all at the finish.

## Adding books from a shelf

Add → **From a shelf photo**. Photograph a shelf or a stack, tap **Copy prompt**, and paste it with the photo into your own AI app (Claude, Gemini…). Paste its answer back and tap **Read the list**: each book shows whether it is new, a physical copy of a book you have in another format, already on your shelves, already in your Inbox, or a repeat — those last three start unchecked. Choose Owned or Borrowed and **Add** — the books wait in your Inbox.

To fill in the details and cover, link each book to its page. Hebrew books are looked up on Simania: **Find on Simania** opens its search; on the book's page tap Share → Copy link and paste it into the card (or, once set up, tap the optional **mylib** bookmarklet instead). English books are looked up on Open Library, right in the app: **Search Open Library** and pick the right one. Each card can switch between the two. **Add one book** works the same way and adds the book straight to your library after one review. My Library never searches or crawls Simania itself — it reads only the one page you link; Open Library is searched through its public API, once per tap.

**Scan barcode** (next to every look-up) reads the ISBN barcode on a book's back cover with the phone's camera, or from a photo, or typed. The picture is read on the phone; only the number is sent. The ISBN is looked up on Open Library and at the National Library of Israel (an Israeli ISBN, 978-965, asks the National Library first), and the book opens for review — after **Add**, the scanner opens again for the next book. Not found on either: the ISBN waits on the Simania tab. The National Library's search API needs a free personal key ([sign up](https://api2.nli.org.il/signup/)): set it as `NLI_API_KEY` on the server; without one, ISBNs are looked up on Open Library only. Each scan makes at most three requests (one to Open Library, two to the National Library).

## Wishlist

Each person keeps a list of books they want, and everyone in the household can read it (handy for gift ideas). To add a book, send its Simania or Open Library page the same way as **Add one book** and choose **Wishlist**, or press **Want it** on a book's page. A wish can name formats (any if none), a language and a note. A book you wish for that nobody owns yet lives only on the Wishlist page; in the Library, Availability → Wanted shows it. Books on someone's list carry a gift mark in the Library. **Bought** adds your copy, pre-filled from the page you shared, and removes the wish.

## Running on a server

"Run it" above is enough to try the app. For a long-lived install use `deploy/compose.yaml`: your data and backups in host folders you choose (ideally on two different disks), checks that refuse to start when a disk isn't mounted, a nightly backup, and a reverse proxy in front. It builds the image on the server from a release tag, and the image reads its version from that tag (`deploy/git-version.sh`), so `/health`, the startup log and the backup file names always say what is running. No image is published anywhere.

Settings live in `deploy/.env` (copy `deploy/.env.example`; each setting is explained there):

- `DATA_DIR`: the host folder holding `postgres/` and `assets/` (covers).
- `BACKUP_DIR`: the host folder for backups. It must not be inside `DATA_DIR`.
- `PROTECTED_PATHS`: colon-separated host folders the app must never write to (your media library, say).
- `POSTGRES_PASSWORD`, `APP_SECRET_KEY`, `TZ`, `BACKUP_SCHEDULE`, `BASE_PATH`, `NLI_API_KEY` and the optional cloud backup.

### First install

1. Clone this repository and check out the latest release tag: `git checkout vX.Y.Z`.
2. Create the folders and the volume markers. The markers let the app refuse to start when a disk isn't mounted:
   ```sh
   sudo install -d -o 1000 -g 1000 /srv/my-library/data/assets /mnt/backup/my-library
   sudo install -d /srv/my-library/data/postgres
   sudo -u '#1000' touch /srv/my-library/data/assets/.my-library-volume /mnt/backup/my-library/.my-library-volume
   ```
3. `cp deploy/.env.example deploy/.env` and set `DATA_DIR`, `BACKUP_DIR`, `PROTECTED_PATHS`, `POSTGRES_PASSWORD` (`openssl rand -hex 24`) and `APP_SECRET_KEY` (`openssl rand -base64 32`).
4. The app joins an external Docker network named `shared`, where your reverse proxy reaches it as `my-library:3000`. Create it once: `docker network create shared`.
5. `cd deploy && docker compose up -d --build`. The first build takes a while on a small machine.
6. Point your reverse proxy at it: `deploy/nginx/mylibrary.home.arpa.conf` is an nginx example (also join nginx to `shared`). Without a proxy, the app also answers on `http://127.0.0.1:${APP_PORT}` on the server itself.
7. Open the app, create the admin, then Admin → Backups → **Back up now**.

Every host folder in the stack must already exist. If a disk is not mounted, Docker refuses to start the stack rather than writing to the wrong one.

### Upgrade

Take a backup (Admin → Backups → **Back up now**), then check out the new tag and rebuild:

```sh
git fetch --tags && git checkout vX.Y.Z
cd deploy && docker compose up -d --build
```

On start the app:
- takes a `pre-upgrade` backup, if the new version has migrations;
- applies each migration in its own transaction.

If the backup or a migration fails, the app stays up on a maintenance page that names the migration and the backup to restore. Nothing half-migrated is left: the failing migration is rolled back.

If the database drops mid-upgrade (or the app loses its backup or migration lock), that is not a failure. The app logs `[startup] lost the database during start-up (<code>; attempt <n>); waiting for it, then starting again`, waits for the database and carries on. It reuses the pre-upgrade backup it already took, and skips the migrations that already committed. Only repeated losses give up:
- `Upgrading kept failing at migration <tag>: 10 attempts in a row lost the database or the migration lock there …`, which also names the migrations of this upgrade that did apply and the backup to restore;
- `The pre-upgrade backup kept failing: 10 attempts in a row lost the database or the backup lock …`, with nothing migrated.

In both cases, check that the database stays up and is not overloaded, then restart the app.

Compose recreates the app before the worker, so the previous worker keeps running while the new app migrates. That is safe because migrations are additive only: the old worker never finds a column or table it uses gone.

Afterwards, `docker image prune` removes the untagged images earlier builds left behind.

A release that updates pg-boss migrates its job tables when it starts, outside the checks above. Roll such a release back by restoring the pre-upgrade backup (see Roll back), not only by changing the tag. If that release had no migrations of its own, no pre-upgrade backup was taken: restore the last backup from before the upgrade, which is why you take one first.

### Restore

Admin → Backups → **Restore** on a backup, or upload a `.zip` under "Restore from a file", then type `restore` to confirm. The app:
- backs up the current state first (`pre-restore`);
- shows a maintenance page for a few minutes, and pauses the worker;
- restores into a fresh database and upgrades it if the backup is older;
- re-seals saved source logins to this install's `APP_SECRET_KEY`;
- swaps it in, then shows a summary.

If anything fails before the swap, the live data is untouched. The previous database (`mylib_prev_…`) is kept until the next successful backup. Anyone who signed in after the backup was made has to sign in again.

From the command line (when the app can't start), in `deploy/`:

```sh
docker compose -p my-library stop app worker
docker compose -p my-library run --rm app node dist/restore-cli.js /backups/<backup file>.zip
docker compose -p my-library up -d
```

### Roll back

1. Check out the previous tag (`git checkout vX.Y.Z`) and, in `deploy/`, `docker compose -p my-library build`.
2. `docker compose -p my-library stop app worker`
3. `docker compose -p my-library run --rm app node dist/restore-cli.js /backups/<the pre-upgrade backup>.zip`. The pre-upgrade backup has the older schema, which the previous version accepts; a newer backup is refused.
4. `docker compose -p my-library up -d`.

### Cloud backup

Optional. The worker copies `BACKUP_DIR`'s backups to Backblaze B2 (or any S3-compatible storage) with [restic](https://restic.net), which encrypts them on the server. This matters because every backup holds `APP_SECRET_KEY`. A copy starts after each backup the worker makes, and every hour while the cloud is missing the newest backup (for example, a pre-upgrade backup, or a copy that failed). After uploading, it reads the newest backup back and compares it with the file on disk; only then is the copy "verified". It then removes old copies (keeping 14 daily, 12 monthly and one per year forever) and runs `restic check`; a failure in those two is a warning, not a failed copy. Admin → Backups shows the last copy or the error, and a banner warns when no verified copy was made in 48 hours.

Set up, once:
1. In Backblaze: a **private** bucket, and an application key with read and write access to it. A bucket can hold other apps' restic repositories next to this one (each in its own folder). Under the bucket's Lifecycle Settings choose **Keep only the last version of the file**, or the space restic frees is never released.
2. Make a restic password, `openssl rand -base64 32`, and **save it in your password manager first**. Without it nobody can read the copies, ever.
3. In `deploy/.env`: `RESTIC_REPOSITORY=s3:https://<bucket endpoint>/<bucket>/my-library`, `RESTIC_PASSWORD`, and the key as `AWS_ACCESS_KEY_ID` (keyID) and `AWS_SECRET_ACCESS_KEY` (applicationKey). Only the worker receives them. Redeploy; the first copy starts within a minute, and creates the repository.

Restore drill (now, then every few months), on any machine with Docker:

```sh
export RESTIC_REPOSITORY=... RESTIC_PASSWORD=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
docker run --rm -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY restic/restic:0.18.1 snapshots --host my-library
docker run --rm -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -v "$PWD/restored:/restored" restic/restic:0.18.1 restore latest --host my-library --target /restored
```

The backups land in `restored/backups/` as the same `.zip` files Admin → Backups lists. Restore one there with "Restore from a file", or with `restore-cli.js` as in Roll back. On a new machine that is the whole recovery: install as in First install, then restore the zip.

When a copy fails, the message is restic's own: a wrong password, a key the storage refused, or the storage unreachable (an unreachable cloud gives up after two minutes; the next try is an hour later). `docker compose -p my-library logs worker | grep cloud` shows every run. If restic reports the repository as locked and no copy is running, remove the stale lock with `docker compose -p my-library exec worker restic unlock` (the worker has the repository settings), and for a damaged repository use restic's own `check --read-data` and `repair` commands the same way.

### Move DATA_DIR

Stop the stack, copy the folder, change one setting, start:

```sh
docker compose -p my-library stop
sudo rsync -aHAX --numeric-ids /srv/my-library/data/ /new/place/my-library-data/
# set DATA_DIR=/new/place/my-library-data in deploy/.env
docker compose -p my-library up -d
```

`rsync` carries the `.my-library-volume` marker along. Delete the old folder once the app is back.

### What a restored install needs

- The backup `.zip` and nothing else. It holds the database, the covers and the secret key, so keep copies private.
- The same app version as the backup, or a newer one.
- A stack set up as in "First install". Any `APP_SECRET_KEY` works: the restore re-seals saved logins to it.
- Then restore with the command line above, or create a throwaway admin on the fresh install and restore from Admin → Backups. The restore replaces the throwaway admin with the backup's people.

### Serving under a sub-path

By default the app is served at the root of its own host name (`http://mylibrary.home.arpa/`). To serve it under a prefix of another site instead, e.g. `http://192.168.1.50/mylibrary/`:

1. Set `BASE_PATH=/mylibrary` in `deploy/.env` and redeploy with `--build`. The web app is built with the prefix baked in, so the image is rebuilt; the server reads the same value at run time.
2. Add the `location` blocks from `deploy/nginx/mylibrary-subpath.locations` to the nginx `server` that answers for that host, and reload nginx. They pass the path through with the prefix kept (`proxy_pass http://$upstream;`, no URI part). The app also works if a proxy strips the prefix instead.

Everything moves under the prefix: pages, assets, the PWA manifest and service worker, `/trpc`, covers, backup uploads and downloads, the maintenance page, and the session cookie (`Path=/mylibrary`). `/health` answers both with and without the prefix, so the container's health check is unchanged. Changing the prefix signs everyone out once (the cookie path changes). Unset or `/`, nothing changes.

For local development, run both with the same value: `BASE_PATH=/mylibrary pnpm dev`, then open `http://localhost:5173/mylibrary/`.

### Notes

- During a `config` maintenance failure, sign-in is blocked. Read the app logs to see what's wrong.
- If Docker starts before a data or backup disk is mounted, the containers fail once and need a redeploy. To avoid this, add a `systemd` drop-in for `docker.service` with `RequiresMountsFor=<the mount point>`.
- After a restore, one catch-up scheduled backup may run.
- Backups contain the secret key that unlocks saved source logins: treat backup files as sensitive.

## Security

My Library is built for a home network. It serves plain HTTP unless you put an HTTPS proxy in front (then set `COOKIE_SECURE=true`). Passwords are hashed, saved source logins are encrypted with `APP_SECRET_KEY`, and sign-in attempts are throttled, but it has had no security audit and no two-factor sign-in. Don't expose it to the internet; reach it from outside over a VPN instead.

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

`patches/postgres@3.4.9.patch` fixes two upstream bugs in the `postgres` driver, both triggered by a dropped connection:
- a query sent on the dead connection (a transaction's ROLLBACK) was written to a null socket, and the uncaught error crashed the process;
- the connection kept the dropped query and its error, so a refused reconnect looped at once, forever, and a graceful `end()` never settled.

pnpm applies the patch on `pnpm install`. pnpm refuses an unused patch, so `pnpm install` fails loudly once `postgres` moves past 3.4.9, and a version bump cannot drop the patch silently. After such a bump, run `packages/db/src/driver.test.ts` against the new version without the patch. If it passes, delete the patch and its `patchedDependencies` entry in `pnpm-workspace.yaml`. If not, port the patch to the new version.

Dev Audiobookshelf (optional):

```sh
pnpm dev:seed-audiobooks -- --count 3   # copies 3 small book folders from Z:\Media\Audiobooks (read-only) into dev-data/
pnpm dev:abs                           # Audiobookshelf on http://localhost:13378
```

First time only, in Audiobookshelf: create the root user; add a library of type *Books* with the folder `/audiobooks` and let it scan; copy your user's API token. Then in My Library (`pnpm dev`): Admin → Sources → Add source with `http://localhost:13378` and that token.

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

Layout and libraries: see "Stack" above.

## License

[MIT](LICENSE): free to use, change and share. The software comes as is, without warranty of any kind. Keep your own backups.

My Library is not affiliated with Simania, Open Library, the National Library of Israel, Hardcover, Audiobookshelf, Calibre, Readarr or Chaptarr. It reads only what you ask it to from them, with your own keys where they need one, so their terms of use still apply to you.
