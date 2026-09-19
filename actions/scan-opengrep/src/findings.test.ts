import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockingCount,
  fatalMessages,
  isFatal,
  scanDidNotRun,
  scannedNothing,
  normaliseReport,
  normaliseRuleId,
  normaliseSarif,
  parseFailOn,
  rulePrefixes,
  summarise,
  type OpengrepReport,
  type OpengrepResult,
  type Severity
} from './findings.js'

const result = (severity: Severity, checkId = 'r', line = 1, file = 'a.java'): OpengrepResult => ({
  check_id: checkId,
  path: file,
  start: { line },
  extra: { severity, message: 'm' }
})

test('rulePrefixes derives the full dotted path OpenGrep prepends', () => {
  const [full] = rulePrefixes('/home/runner/.cache/opengrep-rules/abc')
  assert.equal(full, 'home.runner..cache.opengrep-rules.abc.')
})

test('rulePrefixes also derives the bare directory name, stripped of leading dots', () => {
  const [, short] = rulePrefixes('/work/repo/.opengrep')
  assert.equal(short, 'opengrep.')
})

test('normaliseRuleId strips the full-path prefix used for rules outside the scanned tree', () => {
  const prefixes = rulePrefixes('/tmp/og-rules')
  assert.equal(
    normaliseRuleId('tmp.og-rules.java.lang.security.audit.unsafe-reflection', prefixes),
    'java.lang.security.audit.unsafe-reflection'
  )
})

test('normaliseRuleId strips the short prefix used for a repository-local .opengrep', () => {
  const prefixes = rulePrefixes('/work/repo/.opengrep')
  assert.equal(normaliseRuleId('opengrep.kestra-probe-rule', prefixes), 'kestra-probe-rule')
})

test('rulePrefixes yields nothing for a registry scan, whose ids are already clean', () => {
  assert.deepEqual(rulePrefixes(''), [])
})

test('normaliseRuleId is a no-op when there is no rules root to strip', () => {
  const id = 'java.lang.security.audit.unsafe-reflection.unsafe-reflection'
  assert.equal(normaliseRuleId(id, rulePrefixes('')), id)
})

test('normaliseReport leaves registry rule ids untouched', () => {
  const report = { results: [result('ERROR', 'java.lang.security.audit.x')] }
  assert.equal(normaliseReport(report, '').results?.[0]?.check_id, 'java.lang.security.audit.x')
})

test('normaliseRuleId leaves an already-clean id untouched', () => {
  assert.equal(normaliseRuleId('java.lang.correctness.x', rulePrefixes('/tmp/og-rules')), 'java.lang.correctness.x')
})

test('normaliseReport rewrites every check_id and keeps the other fields', () => {
  const report: OpengrepReport = { results: [result('ERROR', 'tmp.og-rules.java.x')], errors: [] }
  const normalised = normaliseReport(report, '/tmp/og-rules')
  assert.equal(normalised.results?.[0]?.check_id, 'java.x')
  assert.equal(normalised.results?.[0]?.extra.severity, 'ERROR')
})

test('normaliseReport copes with a report that has no results at all', () => {
  assert.deepEqual(normaliseReport({}, '/tmp/og-rules').results, [])
})

test('normaliseSarif rewrites ids in both results and the driver rule list', () => {
  const sarif = {
    runs: [
      {
        tool: { driver: { rules: [{ id: 'tmp.og-rules.java.x' }] } },
        results: [{ ruleId: 'tmp.og-rules.java.x' }]
      }
    ]
  }
  const normalised = normaliseSarif(sarif, '/tmp/og-rules')
  assert.equal(normalised.runs[0].results[0].ruleId, 'java.x')
  assert.equal(normalised.runs[0].tool.driver.rules[0].id, 'java.x')
})

test('normaliseSarif tolerates a SARIF document with no runs', () => {
  assert.doesNotThrow(() => normaliseSarif({}, '/tmp/og-rules'))
})

test('summarise counts each severity, the total and the parse errors', () => {
  const report: OpengrepReport = {
    results: [result('ERROR'), result('ERROR'), result('WARNING'), result('INFO')],
    errors: [{}, {}]
  }
  const summary = summarise(report)
  assert.equal(summary.ERROR, 2)
  assert.equal(summary.WARNING, 1)
  assert.equal(summary.INFO, 1)
  assert.equal(summary.total, 4)
  assert.equal(summary.parseErrors, 2)
})

test('summarise returns zeroes for an empty report', () => {
  assert.deepEqual(summarise({}), {
    ERROR: 0, WARNING: 0, INFO: 0, total: 0, parseErrors: 0, fatalErrors: 0, filesScanned: 0
  })
})

test('blockingCount never blocks in advisory mode, whatever was found', () => {
  const summary = summarise({ results: [result('ERROR'), result('WARNING')] })
  assert.equal(blockingCount(summary, 'none'), 0)
})

test('blockingCount at ERROR ignores warnings', () => {
  const summary = summarise({ results: [result('ERROR'), result('WARNING'), result('INFO')] })
  assert.equal(blockingCount(summary, 'ERROR'), 1)
})

test('blockingCount at WARNING includes errors as well', () => {
  const summary = summarise({ results: [result('ERROR'), result('WARNING'), result('INFO')] })
  assert.equal(blockingCount(summary, 'WARNING'), 2)
})

test('blockingCount is zero when nothing was found', () => {
  assert.equal(blockingCount(summarise({}), 'ERROR'), 0)
})

test('parseFailOn accepts the three valid gates and rejects anything else', () => {
  assert.equal(parseFailOn('none'), 'none')
  assert.equal(parseFailOn('ERROR'), 'ERROR')
  assert.equal(parseFailOn('WARNING'), 'WARNING')
  assert.throws(() => parseFailOn('bogus'), /Unknown fail-on-severity 'bogus'/)
})


// --- telling "clean" apart from "did not run" -------------------------------------------------
// The registry is fetched at scan time, so a 404 or an outage yields a perfectly well-formed
// report with zero results. These are the tests that stop that rendering as a green build.

const scanned = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}.java`)

test('summarise counts PartialParsing as cosmetic, not fatal', () => {
  const summary = summarise({
    results: [],
    errors: [{ level: 'warn', type: ['PartialParsing', []] }],
    paths: { scanned: scanned(3) }
  })
  assert.equal(summary.parseErrors, 1)
  assert.equal(summary.fatalErrors, 0)
})

test('summarise counts a SemgrepError as fatal', () => {
  const summary = summarise({
    results: [],
    errors: [{ level: 'error', type: 'SemgrepError', message: 'Failed to download configuration' }],
    paths: { scanned: [] }
  })
  assert.equal(summary.fatalErrors, 1)
  assert.equal(summary.parseErrors, 0)
})

test('summarise records how many files were actually scanned', () => {
  assert.equal(summarise({ paths: { scanned: scanned(294) } }).filesScanned, 294)
  assert.equal(summarise({}).filesScanned, 0)
})

test('isFatal keys off the level, not the type', () => {
  assert.equal(isFatal({ level: 'error' }), true)
  assert.equal(isFatal({ level: 'warn' }), false)
  assert.equal(isFatal({}), false)
})

test('scanDidNotRun catches a failed rule download that produced an empty report', () => {
  const summary = summarise({
    results: [],
    errors: [{ level: 'error', type: 'SemgrepError', message: 'HTTP 404' }],
    paths: { scanned: [] }
  })
  assert.equal(summary.total, 0)
  assert.equal(scanDidNotRun(summary), true)
})

test('scanDidNotRun is false when a ruleset simply matched no files, e.g. p/javascript on a Java repo', () => {
  const summary = summarise({ results: [], errors: [], paths: { scanned: [] } })
  assert.equal(scanDidNotRun(summary), false)
  assert.equal(scannedNothing(summary), true)
})

test('a scan path that does not exist is caught, because OpenGrep reports it as a fatal error', () => {
  const summary = summarise({
    results: [],
    errors: [{ level: 'error', type: 'SemgrepError', message: 'File not found: does-not-exist' }],
    paths: { scanned: [] }
  })
  assert.equal(scanDidNotRun(summary), true)
})

test('scannedNothing is false once any file was looked at', () => {
  assert.equal(scannedNothing(summarise({ results: [], errors: [], paths: { scanned: scanned(3) } })), false)
})

test('scanDidNotRun is false for a genuinely clean scan of real files', () => {
  const summary = summarise({ results: [], errors: [], paths: { scanned: scanned(294) } })
  assert.equal(summary.total, 0)
  assert.equal(scanDidNotRun(summary), false)
})

test('scanDidNotRun is false for a scan with findings and only partial-parse warnings', () => {
  const summary = summarise({
    results: [result('ERROR')],
    errors: [{ level: 'warn', type: ['PartialParsing', []] }],
    paths: { scanned: scanned(294) }
  })
  assert.equal(scanDidNotRun(summary), false)
})

test('fatalMessages surfaces something actionable and skips the warnings', () => {
  const messages = fatalMessages({
    errors: [
      { level: 'warn', type: ['PartialParsing', []], message: 'ignore me' },
      { level: 'error', type: 'SemgrepError', message: 'Failed to download configuration from https://semgrep.dev/p/nope HTTP 404.' }
    ]
  })
  assert.deepEqual(messages, ['Failed to download configuration from https://semgrep.dev/p/nope HTTP 404.'])
})
