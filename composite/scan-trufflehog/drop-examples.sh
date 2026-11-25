#!/usr/bin/env bash
# Drops unverified findings that sit inside documentation examples, where placeholder credentials are shown
# on purpose: the `code = """..."""` text block of a Java `@Example`, a whole `@Schema(...)` annotation
# (title, description, example and defaultValue land in the plugin docs, e.g. `jdbc:ucanaccess:///path`), and
# a fenced code block (``` or ~~~) of a Markdown file (README.md, plugin doc/*.md, e.g. a flow with
# `url: jdbc:postgresql://db.example.invalid:5432/analytics`). A verified secret is kept wherever it is.
# TruffleHog places a finding by looking its Raw value up in the file; when a detector rewrites the value (JDBC
# reports both `jdbc:trino://host:port/` and a cleaned-up `jdbc:trino://host:port/`).`), the lookup fails and the
# reported line is off (84 for a match on line 82, past the end of its @Schema). So a finding whose Raw is not on
# any line of the file is placed again on the lines holding the longest prefix of it (8 characters at least), and
# dropped only if all of them are inside an example.
# Usage: drop-examples.sh <trufflehog.ndjson>, rewritten in place.
set -euo pipefail

report="$1"
ranges='{}'
placed='{}'

# Files whose examples are looked at, as a jq filter on the file path.
documented='test("\\.(java|md|mdx|markdown)$")'

java_examples='
    /@Example\(/ { example = 1 }
    example && !block && /code[[:space:]]*=[[:space:]]*"""/ { block = 1; start = NR; next }
    block && /"""/ { print start, NR; block = 0; example = 0 }

    # @Schema(...): from the annotation to its closing parenthesis, counting parentheses outside string
    # literals and text blocks only, since descriptions often contain "(" or ")"
    !schema && /@Schema\(/ { schema = 1; depth = 0; str = 0; text = 0; sstart = NR; from = index($0, "@Schema(") + 7 }
    schema {
      for (i = (NR == sstart ? from : 1); i <= length($0); i++) {
        c = substr($0, i, 1)
        if (text) { if (substr($0, i, 3) == "\"\"\"") { text = 0; i += 2 }; continue }
        if (str) { if (c == "\\") i++; else if (c == "\"") str = 0; continue }
        if (substr($0, i, 3) == "\"\"\"") { text = 1; i += 2 }
        else if (c == "\"") str = 1
        else if (c == "(") depth++
        else if (c == ")" && --depth == 0) { print sstart, NR; schema = 0; break }
      }
    }
'

# A fence is 3+ backticks or tildes, indented or not (code blocks in list items); it closes on a line holding
# only a fence of the same character, at least as long. An unclosed fence runs to the end of the file.
markdown_examples='
    match($0, /^[[:space:]]*(```+|~~~+)/) {
      fence = substr($0, RSTART, RLENGTH); sub(/^[[:space:]]*/, "", fence)
      if (open == "") { open = substr(fence, 1, 1); size = length(fence); start = NR; next }
      if (substr(fence, 1, 1) == open && length(fence) >= size && $0 ~ /^[[:space:]]*(```+|~~~+)[[:space:]]*$/) {
        print start, NR; open = ""
      }
    }
    END { if (open != "") print start, NR }
'

while IFS= read -r file; do
  [ -f "${file}" ] || continue
  case "${file}" in
    *.java) program="${java_examples}" ;;
    *) program="${markdown_examples}" ;;
  esac
  found="$(awk "${program}" "${file}" | jq -Rsc 'split("\n") | map(select(length > 0) | split(" ") | map(tonumber))')"
  ranges="$(jq -c --arg f "${file}" --argjson r "${found}" '.[$f] = $r' <<< "${ranges}")"
done < <(jq -r 'select(.DetectorName != null and (.Verified | not))
    | (.SourceMetadata.Data.Filesystem // .SourceMetadata.Data.Git // {}) | .file // empty
    | select('"${documented}"')' "${report}" | sort -u)

# The raw value is passed through the environment and never printed.
while IFS=$'\t' read -r file raw64; do
  [ -f "${file}" ] || continue
  lines="$(RAW="$(base64 -d <<< "${raw64}")" awk '
    BEGIN { raw = ENVIRON["RAW"] }
    { text[NR] = $0 }
    END {
      for (k = length(raw); k >= 8; k--) {
        p = substr(raw, 1, k); out = ""
        for (i = 1; i <= NR; i++) if (index(text[i], p)) out = out " " i
        if (out != "") { if (k < length(raw)) print out; exit }
      }
    }' "${file}" | jq -Rsc '[scan("[0-9]+") | tonumber]')"
  placed="$(jq -c --arg f "${file}" --arg r "${raw64}" --argjson l "${lines}" '.[$f][$r] = $l' <<< "${placed}")"
done < <(jq -r 'select(.DetectorName != null and (.Verified | not))
    | ((.SourceMetadata.Data.Filesystem // .SourceMetadata.Data.Git // {}) | .file // empty) as $f
    | select($f | '"${documented}"') | [$f, (.Raw // "" | @base64)] | @tsv' "${report}" | sort -u)

tmp="${report}.tmp"
jq -c --argjson ranges "${ranges}" --argjson placed "${placed}" '
  (.SourceMetadata.Data.Filesystem // .SourceMetadata.Data.Git // {}) as $at
  | ($ranges[$at.file // ""] // []) as $r
  | ($placed[$at.file // ""][.Raw // "" | @base64] // []) as $moved
  | def inside($n): $r | any(.[0] <= $n and $n <= .[1]);
  select(
      .Verified
      or ($at.line // 0) == 0
      or ((inside($at.line) or ($moved != [] and ($moved | all(. as $n | inside($n))))) | not)
    )' "${report}" > "${tmp}"
mv "${tmp}" "${report}"
