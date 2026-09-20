import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OpengrepReport, OpengrepResult, Severity } from './findings.js'
import { applySuppressions, describeSuppression, isSuppressed, subjectFor, type IgnoreRule, type LineReader } from './suppress.js'

const MUTABLE_TAG = 'yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag'

const finding = (lines: string, checkId = MUTABLE_TAG, severity: Severity = 'WARNING'): OpengrepResult => ({
  check_id: checkId,
  path: '.github/workflows/release.yml',
  start: { line: 1 },
  extra: { severity, message: 'mutable tag', lines }
})

// The real workflow lines this was built for: seven third-party references that must survive, and
// one kestra-io/actions reference that must not.
const REAL_REPORT: OpengrepReport = {
  results: [
    finding('        uses: actions/checkout@v7'),
    finding('      - uses: dorny/paths-filter@v4'),
    finding('        uses: docker/setup-qemu-action@v4'),
    finding('        uses: docker/setup-buildx-action@v4'),
    finding('        uses: docker/login-action@v4'),
    finding('        uses: docker/build-push-action@v7'),
    finding('        uses: actions/checkout@v7'),
    finding('        uses: kestra-io/actions/composite/plugin-release@main')
  ]
}

const KESTRA_RULE: IgnoreRule = {
  rule: 'github-actions-mutable-action-tag',
  match: 'kestra-io/actions/',
  reason: 'consumers track @main by design'
}

test('isSuppressed matches on a substring of the rule id, not the whole doubled id', () => {
  assert.equal(isSuppressed(finding('uses: kestra-io/actions/x@main'), KESTRA_RULE, /kestra-io\/actions\//), true)
})

test('isSuppressed leaves a different rule alone even when the line matches', () => {
  const other = finding('uses: kestra-io/actions/x@main', 'yaml.github-actions.security.secrets-inherit.secrets-inherit')
  assert.equal(isSuppressed(other, KESTRA_RULE, /kestra-io\/actions\//), false)
})

test('isSuppressed leaves the same rule alone when the line does not match', () => {
  assert.equal(isSuppressed(finding('uses: docker/login-action@v4'), KESTRA_RULE, /kestra-io\/actions\//), false)
})

test('isSuppressed does not suppress a finding that carries no snippet', () => {
  const noLines: OpengrepResult = {
    check_id: MUTABLE_TAG,
    path: 'x.yml',
    start: { line: 1 },
    extra: { severity: 'WARNING', message: 'm' }
  }
  assert.equal(isSuppressed(noLines, KESTRA_RULE, /kestra-io\/actions\//), false)
})

test('the kestra-io suppression keeps every third-party mutable tag', () => {
  const { report } = applySuppressions(REAL_REPORT, [KESTRA_RULE])
  assert.equal(report.results?.length, 7)
  assert.equal(report.results?.every(r => !r.extra.lines?.includes('kestra-io/actions/')), true)
})

test('the kestra-io suppression removes exactly the kestra-io reference', () => {
  const { total, suppressions } = applySuppressions(REAL_REPORT, [KESTRA_RULE])
  assert.equal(total, 1)
  assert.equal(suppressions[0]?.count, 1)
})

test('excluding the whole rule instead would have hidden all eight, which is the bug this avoids', () => {
  const blunt: IgnoreRule = { rule: 'github-actions-mutable-action-tag', match: '.' }
  assert.equal(applySuppressions(REAL_REPORT, [blunt]).report.results?.length, 0)
})

test('applySuppressions is a no-op with no rules, returning the same report', () => {
  const result = applySuppressions(REAL_REPORT, [])
  assert.equal(result.report, REAL_REPORT)
  assert.equal(result.total, 0)
})

test('applySuppressions reports a zero count, so a stale suppression is visible', () => {
  const stale: IgnoreRule = { rule: 'rule-that-moved-upstream', match: 'anything' }
  const { suppressions, total } = applySuppressions(REAL_REPORT, [stale])
  assert.equal(total, 0)
  assert.equal(suppressions.length, 1)
  assert.equal(suppressions[0]?.count, 0)
})

test('applySuppressions counts each rule separately and never double-counts a finding', () => {
  const overlapping: IgnoreRule[] = [
    { rule: 'github-actions-mutable-action-tag', match: 'kestra-io/actions/' },
    { rule: 'github-actions-mutable-action-tag', match: 'plugin-release' }
  ]
  const { total, suppressions } = applySuppressions(REAL_REPORT, overlapping)
  assert.equal(total, 1)
  assert.deepEqual(suppressions.map(s => s.count), [1, 0])
})

test('applySuppressions handles a report with no results', () => {
  assert.deepEqual(applySuppressions({}, [KESTRA_RULE]).report.results, [])
})

test('applySuppressions rejects an invalid regular expression with a usable message', () => {
  assert.throws(
    () => applySuppressions(REAL_REPORT, [{ rule: 'x', match: '([' }]),
    /Invalid 'match' regular expression in ignore-findings for rule 'x'/
  )
})

test('a match can be a regex, not just a literal', () => {
  // setup-qemu, setup-buildx, login and build-push — the four docker/ references in the fixture.
  const rule: IgnoreRule = { rule: 'mutable-action-tag', match: '^\\s*uses:\\s*docker/' }
  assert.equal(applySuppressions(REAL_REPORT, [rule]).total, 4)
})

test('describeSuppression reports the count, the pattern and the reason', () => {
  const text = describeSuppression({ rule: KESTRA_RULE, count: 1 })
  assert.match(text, /1 finding\(s\) matching \/kestra-io\/actions\/\//)
  assert.match(text, /consumers track @main by design/)
})

test('describeSuppression omits the dash when no reason was given', () => {
  const text = describeSuppression({ rule: { rule: 'r', match: 'm' }, count: 0 })
  assert.equal(text.includes('—'), false)
})

// --- context-anchored suppression ---------------------------------------------------------------
// secrets-inherit flags the `secrets: inherit` line, but what makes it acceptable is the `uses:`
// above it. These cover matching against that anchor instead of the finding's own line.

const WORKFLOW = [
  'jobs:',
  '  check:',
  '    uses: kestra-io/actions/.github/workflows/plugins.yml@main',
  '    with:',
  '      skip-test: false',
  '    secrets: inherit',
  '  third-party:',
  '    uses: evil-org/workflows/build.yml@main',
  '    secrets: inherit'
].join('\n')

const readWorkflow: LineReader = () => WORKFLOW.split('\n')

const inheritAt = (line: number): OpengrepResult => ({
  check_id: 'yaml.github-actions.security.secrets-inherit.secrets-inherit',
  path: '.github/workflows/main.yml',
  start: { line },
  extra: { severity: 'ERROR', message: 'secrets: inherit', lines: '    secrets: inherit' }
})

const SECRETS_RULE: IgnoreRule = {
  rule: 'secrets-inherit',
  match: 'kestra-io/actions/',
  matchNearest: '^\\s*uses:'
}

test('subjectFor returns the finding line when no anchor is configured', () => {
  const result = inheritAt(6)
  assert.equal(subjectFor(result, { rule: 'x', match: 'y' }), '    secrets: inherit')
})

test('subjectFor walks back to the nearest preceding uses:', () => {
  assert.match(subjectFor(inheritAt(6), SECRETS_RULE, readWorkflow) ?? '', /kestra-io\/actions\//)
})

test('subjectFor picks the nearest anchor, not the first in the file', () => {
  // Line 9 belongs to the third-party job; its nearest uses: is line 8, not line 3.
  assert.match(subjectFor(inheritAt(9), SECRETS_RULE, readWorkflow) ?? '', /evil-org/)
})

test('secrets: inherit into our own workflow is suppressed', () => {
  const { report, total } = applySuppressions({ results: [inheritAt(6)] }, [SECRETS_RULE], readWorkflow)
  assert.equal(total, 1)
  assert.equal(report.results?.length, 0)
})

test('secrets: inherit into a third-party workflow is kept, which is the whole point', () => {
  const { report, total } = applySuppressions({ results: [inheritAt(9)] }, [SECRETS_RULE], readWorkflow)
  assert.equal(total, 0)
  assert.equal(report.results?.length, 1)
})

test('both jobs together: ours is dropped, theirs survives', () => {
  const { report } = applySuppressions({ results: [inheritAt(6), inheritAt(9)] }, [SECRETS_RULE], readWorkflow)
  assert.equal(report.results?.length, 1)
  assert.equal(report.results?.[0]?.start.line, 9)
})

test('an anchor beyond the within window does not suppress', () => {
  const narrow: IgnoreRule = { ...SECRETS_RULE, within: 2 }
  assert.equal(subjectFor(inheritAt(6), narrow, readWorkflow), null)
  assert.equal(applySuppressions({ results: [inheritAt(6)] }, [narrow], readWorkflow).total, 0)
})

test('a missing anchor means no suppression, rather than falling back to the finding line', () => {
  const noAnchor: LineReader = () => ['    secrets: inherit']
  assert.equal(subjectFor(inheritAt(1), SECRETS_RULE, noAnchor), null)
})

test('an unreadable file is treated as no anchor, not as a match', () => {
  assert.equal(applySuppressions({ results: [inheritAt(6)] }, [SECRETS_RULE], () => []).total, 0)
})

test('a context rule without a line reader never suppresses', () => {
  assert.equal(applySuppressions({ results: [inheritAt(6)] }, [SECRETS_RULE]).total, 0)
})

test('an invalid match-nearest pattern is reported against its rule', () => {
  assert.throws(
    () => applySuppressions({ results: [inheritAt(6)] }, [{ rule: 'r', match: 'x', matchNearest: '([' }], readWorkflow),
    /Invalid 'match-nearest' regular expression for rule 'r'/
  )
})

test('describeSuppression mentions the anchor when one is used', () => {
  assert.match(describeSuppression({ rule: SECRETS_RULE, count: 3 }), /near \/\^\\s\*uses:\//)
})
