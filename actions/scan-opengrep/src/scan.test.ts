import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRuleset } from './rules.js'
import { buildScanArgs, parseMode, parseSeverities, resolveMode } from './scan.js'

const ruleset = buildRuleset(['p/java'], null)
const base = {
  ruleset,
  scanPath: '.',
  severities: ['ERROR'],
  jsonOutput: '/tmp/o.json',
  sarifOutput: '/tmp/o.sarif'
}

test('parseMode accepts the three modes and rejects anything else', () => {
  assert.equal(parseMode('auto'), 'auto')
  assert.equal(parseMode('diff'), 'diff')
  assert.equal(parseMode('full'), 'full')
  assert.throws(() => parseMode('quick'), /Unknown OpenGrep mode 'quick'/)
})

test('resolveMode auto picks diff on a pull request and full everywhere else', () => {
  assert.equal(resolveMode('auto', 'pull_request'), 'diff')
  assert.equal(resolveMode('auto', 'push'), 'full')
  assert.equal(resolveMode('auto', 'workflow_dispatch'), 'full')
})

test('resolveMode honours an explicit mode regardless of the event', () => {
  assert.equal(resolveMode('full', 'pull_request'), 'full')
  assert.equal(resolveMode('diff', 'push'), 'diff')
})

test('buildScanArgs uses the scan subcommand, never ci', () => {
  const args = buildScanArgs(base)
  assert.equal(args[0], 'scan')
  assert.equal(args.includes('ci'), false)
})

test('buildScanArgs emits one --config per ruleset', () => {
  const args = buildScanArgs({ ...base, ruleset: buildRuleset(['p/java', 'p/secrets'], null) })
  assert.equal(args.filter(a => a === '--config').length, 2)
  assert.equal(args.includes('p/java'), true)
  assert.equal(args.includes('p/secrets'), true)
})

test('buildScanArgs emits one --severity per requested level', () => {
  const args = buildScanArgs({ ...base, severities: ['ERROR', 'WARNING'] })
  assert.equal(args.filter(a => a === '--severity').length, 2)
})

test('buildScanArgs omits --baseline-commit when there is no baseline', () => {
  assert.equal(buildScanArgs(base).includes('--baseline-commit'), false)
})

test('buildScanArgs adds --baseline-commit for a diff scan', () => {
  const args = buildScanArgs({ ...base, baseline: 'abc123' })
  assert.equal(args[args.indexOf('--baseline-commit') + 1], 'abc123')
})

test('buildScanArgs keeps --no-error so the report is always written', () => {
  assert.equal(buildScanArgs(base).includes('--no-error'), true)
})

test('buildScanArgs puts the scan path last', () => {
  const args = buildScanArgs({ ...base, scanPath: 'ui' })
  assert.equal(args.at(-1), 'ui')
})

test('buildScanArgs writes both report formats', () => {
  const args = buildScanArgs(base)
  assert.equal(args.includes('--json-output=/tmp/o.json'), true)
  assert.equal(args.includes('--sarif-output=/tmp/o.sarif'), true)
})

test('parseSeverities normalises case and trims', () => {
  assert.deepEqual(parseSeverities(' error , Warning '), ['ERROR', 'WARNING'])
})

test('parseSeverities rejects an unknown level and an empty list', () => {
  assert.throws(() => parseSeverities('ERROR,CRITICAL'), /Unknown severity 'CRITICAL'/)
  assert.throws(() => parseSeverities(''), /No severities resolved/)
})

test('buildScanArgs emits one --exclude-rule per excluded rule id', () => {
  const args = buildScanArgs({ ...base, excludeRules: ['a.b.c', 'd.e.f'] })
  assert.equal(args.filter(a => a === '--exclude-rule').length, 2)
  assert.equal(args[args.indexOf('--exclude-rule') + 1], 'a.b.c')
})

test('buildScanArgs emits one --exclude per excluded path pattern', () => {
  const args = buildScanArgs({ ...base, excludePaths: ['**/build/**'] })
  assert.equal(args[args.indexOf('--exclude') + 1], '**/build/**')
})

test('buildScanArgs omits both exclusion flags when there is nothing to exclude', () => {
  const args = buildScanArgs(base)
  assert.equal(args.includes('--exclude-rule'), false)
  assert.equal(args.includes('--exclude'), false)
})
