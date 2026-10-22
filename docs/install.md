# Running on a server

[← Back to the README](../README.md)

The README's "Try it" is enough to see the app. For a long-lived install use `deploy/compose.yaml`: your data and backups in host folders you choose (ideally on two different disks), checks that refuse to start when a disk isn't mounted, a nightly backup, and a reverse proxy in front. It builds the image on the server from a release tag, and the image reads its version from that tag (`deploy/git-version.sh`), so `/health`, the startup log and the backup file names always say what is running. No image is published anywhere.

Settings live in `deploy/.env` (copy `deploy/.env.example`; each setting is explained there):

- `DATA_DIR`: the host folder holding `postgres/` and `assets/` (covers).
- `BACKUP_DIR`: the host folder for backups. It must not be inside `DATA_DIR`.
- `PROTECTED_PATHS`: colon-separated host folders the app must never write to (your media library, say).
- `POSTGRES_PASSWORD`, `APP_SECRET_KEY`, `TZ`, `BACKUP_SCHEDULE`, `BASE_PATH`, `NLI_API_KEY` and the optional cloud backup.

## First install

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

## Upgrade

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

## Restore

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

## Roll back

1. Check out the previous tag (`git checkout vX.Y.Z`) and, in `deploy/`, `docker compose -p my-library build`.
2. `docker compose -p my-library stop app worker`
3. `docker compose -p my-library run --rm app node dist/restore-cli.js /backups/<the pre-upgrade backup>.zip`. The pre-upgrade backup has the older schema, which the previous version accepts; a newer backup is refused.
4. `docker compose -p my-library up -d`.

## Cloud backup

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

## Move DATA_DIR

Stop the stack, copy the folder, change one setting, start:

```sh
docker compose -p my-library stop
sudo rsync -aHAX --numeric-ids /srv/my-library/data/ /new/place/my-library-data/
# set DATA_DIR=/new/place/my-library-data in deploy/.env
docker compose -p my-library up -d
```

`rsync` carries the `.my-library-volume` marker along. Delete the old folder once the app is back.

## What a restored install needs

- The backup `.zip` and nothing else. It holds the database, the covers and the secret key, so keep copies private.
- The same app version as the backup, or a newer one.
- A stack set up as in "First install". Any `APP_SECRET_KEY` works: the restore re-seals saved logins to it.
- Then restore with the command line above, or create a throwaway admin on the fresh install and restore from Admin → Backups. The restore replaces the throwaway admin with the backup's people.

## Serving under a sub-path

By default the app is served at the root of its own host name (`http://mylibrary.home.arpa/`). To serve it under a prefix of another site instead, e.g. `http://192.168.1.50/mylibrary/`:

1. Set `BASE_PATH=/mylibrary` in `deploy/.env` and redeploy with `--build`. The web app is built with the prefix baked in, so the image is rebuilt; the server reads the same value at run time.
2. Add the `location` blocks from `deploy/nginx/mylibrary-subpath.locations` to the nginx `server` that answers for that host, and reload nginx. They pass the path through with the prefix kept (`proxy_pass http://$upstream;`, no URI part). The app also works if a proxy strips the prefix instead.

Everything moves under the prefix: pages, assets, the PWA manifest and service worker, `/trpc`, covers, backup uploads and downloads, the maintenance page, and the session cookie (`Path=/mylibrary`). `/health` answers both with and without the prefix, so the container's health check is unchanged. Changing the prefix signs everyone out once (the cookie path changes). Unset or `/`, nothing changes.

For local development, run both with the same value: `BASE_PATH=/mylibrary pnpm dev`, then open `http://localhost:5173/mylibrary/`.

## Notes

- During a `config` maintenance failure, sign-in is blocked. Read the app logs to see what's wrong.
- If Docker starts before a data or backup disk is mounted, the containers fail once and need a redeploy. To avoid this, add a `systemd` drop-in for `docker.service` with `RequiresMountsFor=<the mount point>`.
- After a restore, one catch-up scheduled backup may run.
- Backups contain the secret key that unlocks saved source logins: treat backup files as sensitive.
