#!/bin/sh
# Prints the release a checkout is, from its git metadata alone (no git binary): the highest vX.Y.Z tag
# on the checked-out commit, without the "v". A commit with no release tag prints 0.0.0-dev+<short sha>.
# Exits 1 when there is no readable HEAD. Usage: git-version.sh <the .git folder>
# The Pi builds the image from Komodo's checkout of a release tag (README → Running on a server), so the
# image names its own version and nobody has to keep a setting in step with the tag.
git_dir=${1:-.git}

head=$(cat "$git_dir/HEAD" 2>/dev/null) || exit 1
case $head in
  "ref: "*)
    ref=${head#ref: }
    sha=$(cat "$git_dir/$ref" 2>/dev/null || awk -v ref="$ref" '$2 == ref { print $1 }' "$git_dir/packed-refs" 2>/dev/null)
    ;;
  *) sha=$head ;;
esac
[ -n "$sha" ] || exit 1

tags=$(
  for f in "$git_dir"/refs/tags/v*; do
    [ -f "$f" ] && [ "$(cat "$f")" = "$sha" ] && basename "$f"
  done
  # packed tags: "<sha> refs/tags/vX.Y.Z"; an annotated one is followed by "^<commit sha>"
  [ -f "$git_dir/packed-refs" ] && awk -v sha="$sha" '
    /^\^/ { if (substr($0, 2) == sha && tag != "") print tag; next }
    { tag = ""; if ($2 ~ /^refs\/tags\/v/) { tag = substr($2, 11); if ($1 == sha) print tag } }
  ' "$git_dir/packed-refs"
)
release=$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$' | sed 's/^v//' | sort -V | tail -n 1)
if [ -n "$release" ]; then
  echo "$release"
else
  echo "0.0.0-dev+$(printf '%s' "$sha" | cut -c1-7)"
fi
