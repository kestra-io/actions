import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarise, type OpengrepReport, type OpengrepResult, type Severity } from './findings.js'
import { buildCommentModel, cellText, renderStepSummary, renderTable } from './report.js'

const result = (severity: Severity, file: string, line: number, message = 'm'): OpengrepResult => ({
  check_id: 'rule',
  path: file,
  start: { line },
  extra: { severity, message }
})

test('cellText collapses newlines so a message cannot break out of its table cell', () => {
  assert.equal(cellText('first line\n  second   line'), 'first line second line')
})

test('cellText escapes pipes, which would otherwise add phantom columns', () => {
  assert.equal(cellText('a | b'), 'a \\| b')
})

test('cellText truncates to the requested length', () => {
  assert.equal(cellText('x'.repeat(500)).length, 300)
  assert.equal(cellText('x'.repeat(50), 10).length, 10)
})

test('buildCommentModel sorts errors before warnings before info', () => {
  const report: OpengrepReport = {
    results: [result('INFO', 'a', 1), result('ERROR', 'b', 1), result('WARNING', 'c', 1)]
  }
  assert.deepEqual(
    buildCommentModel(report, 50).shown.map(r => r.severity),
    ['ERROR', 'WARNING', 'INFO']
  )
})

test('buildCommentModel breaks severity ties by path then line', () => {
  const report: OpengrepReport = {
    results: [result('ERROR', 'b.java', 1), result('ERROR', 'a.java', 9), result('ERROR', 'a.java', 2)]
  }
  assert.deepEqual(
    buildCommentModel(report, 50).shown.map(r => r.location),
    ['a.java:2', 'a.java:9', 'b.java:1']
  )
})

test('buildCommentModel caps the rows and reports the overflow', () => {
  const report: OpengrepReport = {
    results: Array.from({ length: 14 }, (_, i) => result('ERROR', 'a', i + 1))
  }
  const model = buildCommentModel(report, 3)
  assert.equal(model.shown.length, 3)
  assert.equal(model.overflow, 11)
  assert.equal(model.total, 14)
})

test('buildCommentModel reports no overflow when everything fits', () => {
  const model = buildCommentModel({ results: [result('ERROR', 'a', 1)] }, 50)
  assert.equal(model.overflow, 0)
})

test('buildCommentModel handles an empty report', () => {
  const model = buildCommentModel({}, 50)
  assert.deepEqual(model, { total: 0, shown: [], overflow: 0 })
})

test('renderTable emits nothing for no rows, so no empty header is printed', () => {
  assert.deepEqual(renderTable([]), [])
})

test('renderTable emits a header, a separator and one line per row', () => {
  const rows = buildCommentModel({ results: [result('ERROR', 'a.java', 7)] }, 50).shown
  const lines = renderTable(rows)
  assert.equal(lines.length, 3)
  assert.match(lines[2]!, /\| ERROR \| `rule` \| `a\.java:7` \| m \|/)
})

const context = (report: OpengrepReport, maxRows = 50) => ({
  mode: 'full',
  rulesSource: 'registry',
  engineVersion: '1.30.0',
  summary: summarise(report),
  model: buildCommentModel(report, maxRows),
  artifactName: 'opengrep-report'
})

test('renderStepSummary states the mode, rule source and engine version', () => {
  const report: OpengrepReport = { results: [result('ERROR', 'a', 1), result('WARNING', 'b', 2)] }
  const markdown = renderStepSummary(context(report))
  assert.match(markdown, /`full` scan · registry rules · OpenGrep 1\.30\.0/)
})

test('renderStepSummary states the counts, without repeating the word rules', () => {
  const report: OpengrepReport = { results: [result('ERROR', 'a', 1), result('WARNING', 'b', 2)] }
  const markdown = renderStepSummary(context(report))
  assert.match(markdown, /\*\*2\*\* finding\(s\): 1 error, 1 warning, 0 info\./)
  assert.equal(/rules · OpenGrep [\d.]+ rules/.test(markdown), false)
})

test('renderStepSummary omits the table entirely when there is nothing to show', () => {
  const markdown = renderStepSummary(context({}))
  assert.equal(markdown.includes('| Severity |'), false)
  assert.match(markdown, /\*\*0\*\* finding\(s\)/)
})

test('renderStepSummary points at the artifact when rows were dropped', () => {
  const report: OpengrepReport = { results: Array.from({ length: 5 }, (_, i) => result('ERROR', 'a', i + 1)) }
  assert.match(renderStepSummary(context(report, 2)), /… and 3 more, see the `opengrep-report` artifact\./)
})

test('renderStepSummary warns when files were only partially parsed', () => {
  const markdown = renderStepSummary(context({ results: [], errors: [{}, {}, {}] }))
  assert.match(markdown, /3 file\(s\) only partially parsed/)
})

test('renderStepSummary stays quiet about parse errors when there are none', () => {
  assert.equal(renderStepSummary(context({})).includes('partially parsed'), false)
})
