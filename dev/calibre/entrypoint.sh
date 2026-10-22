#!/bin/sh
# First start: create the library, a "Words" integer column (#words), and import the copied samples.
set -eu
LIB=/library
if [ ! -f "$LIB/metadata.db" ]; then
  mkdir -p "$LIB"
  calibredb --library-path "$LIB" add_custom_column words "Words" int
  if [ -d /import ] && [ -n "$(ls -A /import 2>/dev/null)" ]; then
    calibredb --library-path "$LIB" add --recurse /import
  fi
fi
# no --enable-auth: the dev server is open; for a login, add --enable-auth --auth-mode=basic (plan deviation 1)
exec calibre-server --port 8080 "$LIB"
