#!/usr/bin/env bash
# Drops unverified findings in test code and test data, where placeholder credentials are written on purpose
# (a URL parser test on jdbc:postgresql://user:secret@db.example.com, saved API responses under fixtures/).
# A verified secret is kept wherever it is: a real token pasted into a test still gets reported.
# Usage: drop-tests.sh <trufflehog.ndjson>, rewritten in place.
set -euo pipefail

report="$1"

# A test directory anywhere in the path, or a test file by its naming convention.
# Java's src/test/ is skipped by trufflehog-exclude.txt already.
tests='(^|/)(tests?|__tests__|__mocks__|e2e|fixtures|testdata|test-?data|cypress|playwright)/'
tests+='|\.(spec|test)\.(c|m)?[jt]sx?$|\.(spec|test)\.vue$'
tests+='|_test\.(go|py)$|(^|/)test_[^/]*\.py$|(^|/)conftest\.py$'

tmp="${report}.tmp"
jq -c --arg tests "${tests}" '
  ((.SourceMetadata.Data.Filesystem // .SourceMetadata.Data.Git // {}).file // "") as $file
  | select(.Verified or ($file | test($tests) | not))' "${report}" > "${tmp}"
mv "${tmp}" "${report}"
