#!/bin/sh
# Every process in the image (the app, the worker, restore-cli under `compose run`) reports the release
# the image was built from (Dockerfile: CI's tag, or the tag on the checked-out commit), unless
# APP_VERSION is set from outside.
if [ -z "${APP_VERSION:-}" ]; then
  APP_VERSION=$(cat /app/VERSION 2>/dev/null || echo 0.0.0-dev)
  export APP_VERSION
fi
exec "$@"
