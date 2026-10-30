#!/usr/bin/env bash
# Newline separated globs on $1 to the anchored regexes TruffleHog's --exclude-paths reads.
# `**` crosses directories, `*` and `?` stay inside one, and a glob matches the path itself or anything below it.
set -euo pipefail

while IFS= read -r glob; do
  glob="${glob#"${glob%%[![:space:]]*}"}"
  glob="${glob%"${glob##*[![:space:]]}"}"
  glob="${glob#./}"
  [ -z "${glob}" ] && continue
  printf '%s\n' "${glob}" | sed -E \
    -e 's/[.+^$(){}|\\]/\\&/g' \
    -e 's/\[/\\[/g; s/\]/\\]/g' \
    -e 's#\*\*/#\x01#g; s#\*\*#\x02#g; s#\*#[^/]*#g; s#\?#[^/]#g' \
    -e 's#\x01#(.*/)?#g; s#\x02#.*#g' \
    -e 's#^#^#; s#$#(/.*)?$#'
done <<< "${1:-}"
