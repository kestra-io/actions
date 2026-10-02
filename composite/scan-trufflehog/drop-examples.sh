#!/usr/bin/env bash
# Drops unverified findings that sit inside the `code = """..."""` text block of a Java `@Example`:
# plugin docs show placeholder credentials on purpose. A verified secret is kept wherever it is.
# Usage: drop-examples.sh <trufflehog.ndjson>, rewritten in place.
set -euo pipefail

report="$1"
ranges='{}'

while IFS= read -r file; do
  [ -f "${file}" ] || continue
  found="$(awk '
    /@Example\(/ { example = 1 }
    example && !block && /code[[:space:]]*=[[:space:]]*"""/ { block = 1; start = NR; next }
    block && /"""/ { print start, NR; block = 0; example = 0 }
  ' "${file}" | jq -Rsc 'split("\n") | map(select(length > 0) | split(" ") | map(tonumber))')"
  ranges="$(jq -c --arg f "${file}" --argjson r "${found}" '.[$f] = $r' <<< "${ranges}")"
done < <(jq -r 'select(.DetectorName != null and (.Verified | not))
    | (.SourceMetadata.Data.Filesystem // .SourceMetadata.Data.Git // {}) | .file // empty
    | select(endswith(".java"))' "${report}" | sort -u)

tmp="${report}.tmp"
jq -c --argjson ranges "${ranges}" '
  (.SourceMetadata.Data.Filesystem // .SourceMetadata.Data.Git // {}) as $at
  | select(
      .Verified
      or ($at.line // 0) == 0
      or (($ranges[$at.file // ""] // []) | any(.[0] <= $at.line and $at.line <= .[1]) | not)
    )' "${report}" > "${tmp}"
mv "${tmp}" "${report}"
