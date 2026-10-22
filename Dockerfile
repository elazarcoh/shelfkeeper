# syntax=docker/dockerfile:1
# The bundles are plain JavaScript: build them once on the build machine's own platform and copy them
# into each target platform's runtime, so arm64 never runs pnpm under emulation (plan deviation 18).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/connectors/package.json packages/connectors/
COPY packages/jobs/package.json packages/jobs/
COPY e2e/package.json e2e/
# 3d Task 7: pnpm applies patches/postgres@3.4.9.patch during install (pnpm-workspace.yaml patchedDependencies)
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
COPY . .
# BASE_PATH (e.g. /mylibrary) serves the app under that URL prefix: the web build bakes it in (docs/install.md → Serving under a sub-path)
ARG BASE_PATH=/
RUN BASE_PATH=$BASE_PATH pnpm --filter @mylib/web build && pnpm --filter @mylib/server build && pnpm --filter @mylib/worker build

# The release this image is: CI passes APP_VERSION (its tag); a build from a checkout (the Pi, docs/install.md →
# Running on a server) reads the vX.Y.Z tag on the checked-out commit from the context's .git refs
# (.dockerignore lets only HEAD and the refs in). `.gi[t]` matches nothing when there is no .git at all.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS version
COPY deploy/git-version.sh .gi[t] /src/
ARG APP_VERSION=
RUN v="${APP_VERSION:-$(sh /src/git-version.sh /src || true)}" && echo "${v:-0.0.0-dev}" > /VERSION && echo "version: $(cat /VERSION)"

# Only built output (the bundles carry their production dependencies), the PostgreSQL 17 client tools (spec §3)
# and restic, which makes the cloud copy of the backups (#106).
FROM restic/restic:0.18.1 AS restic
FROM node:22-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
# the server must use the prefix the web app was built with
ARG BASE_PATH=/
ENV NODE_ENV=production PORT=3000 WEB_DIST=./public MIGRATIONS_DIR=./drizzle ASSETS_DIR=/data/assets BACKUP_DIR=/backups BASE_PATH=$BASE_PATH
WORKDIR /app
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/worker/dist ./worker
COPY --from=build /repo/packages/db/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./public
# APP_VERSION comes from this file, through the entrypoint
COPY --from=version /VERSION ./VERSION
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/my-library-entrypoint
RUN mkdir -p /data/assets /backups && chown node:node /data/assets /backups
USER node
EXPOSE 3000
ENTRYPOINT ["my-library-entrypoint"]
CMD ["node", "dist/main.js"]
