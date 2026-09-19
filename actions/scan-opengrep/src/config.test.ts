import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig, resolveSettings, type Inputs } from './config.js'
import { DEFAULT_IGNORED_FINDINGS, DEFAULT_RULESETS } from './version.js'

const MUTABLE_TAG =
  'yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag'

const inputs: Inputs = {
  rulesets: '',
  mode: 'auto',
  severity: 'ERROR,WARNING',
  failOnSeverity: 'none'
}

test('parseConfig reads a mapping', () => {
  assert.deepEqual(parseConfig('rulesets:\n  - p/java\n'), { rulesets: ['p/java'] })
})

test('parseConfig treats an empty or comment-only file as no configuration', () => {
  assert.deepEqual(parseConfig(''), {})
  assert.deepEqual(parseConfig('# nothing here\n'), {})
})

test('parseConfig rejects a file that is not a mapping, rather than ignoring it', () => {
  assert.throws(() => parseConfig('- p/java\n'), /must be a YAML mapping/)
  assert.throws(() => parseConfig('just a string\n'), /must be a YAML mapping/)
})

test('resolveSettings falls back to the built-in default when nothing sets rulesets', () => {
  assert.equal(resolveSettings({}, inputs).rulesets, DEFAULT_RULESETS)
})

test('resolveSettings prefers the action input over the built-in default', () => {
  assert.equal(resolveSettings({}, { ...inputs, rulesets: 'p/java' }).rulesets, 'p/java')
})

test('the config file wins over the action input, since it is what a repository owns', () => {
  const settings = resolveSettings({ rulesets: ['p/python'] }, { ...inputs, rulesets: 'p/java' })
  assert.equal(settings.rulesets, 'p/python')
})

test('resolveSettings joins a ruleset list into the comma form the resolver expects', () => {
  assert.equal(resolveSettings({ rulesets: ['p/java', 'p/secrets'] }, inputs).rulesets, 'p/java,p/secrets')
})

test('resolveSettings always applies the org-wide suppressions', () => {
  assert.deepEqual(resolveSettings({}, inputs).ignoreFindings, [...DEFAULT_IGNORED_FINDINGS])
})

test('the mutable-tag rule is suppressed by context, never excluded wholesale', () => {
  const settings = resolveSettings({}, inputs)
  assert.deepEqual(settings.excludeRules, [])
  const ignore = settings.ignoreFindings.find(entry => MUTABLE_TAG.includes(entry.rule))
  assert.equal(ignore?.match, 'kestra-io/actions/')
})

test('a repository suppression is added to the org-wide ones, never replacing them', () => {
  const settings = resolveSettings(
    { 'ignore-findings': [{ rule: 'my.rule', match: 'vendor/' }] },
    inputs
  )
  assert.equal(settings.ignoreFindings.length, DEFAULT_IGNORED_FINDINGS.length + 1)
  assert.equal(settings.ignoreFindings.some(entry => entry.rule === 'my.rule'), true)
})

test('repeating an org-wide suppression does not log it twice with a misleading zero', () => {
  const settings = resolveSettings(
    { 'ignore-findings': [{ rule: 'github-actions-mutable-action-tag', match: 'kestra-io/actions/' }] },
    inputs
  )
  const matching = settings.ignoreFindings.filter(
    entry => entry.rule === 'github-actions-mutable-action-tag' && entry.match === 'kestra-io/actions/'
  )
  assert.equal(matching.length, 1)
})

test('two suppressions for the same rule with different patterns are both kept', () => {
  const settings = resolveSettings(
    {
      'ignore-findings': [
        { rule: 'github-actions-mutable-action-tag', match: 'regclient/actions/' }
      ]
    },
    inputs
  )
  const matching = settings.ignoreFindings.filter(entry => entry.rule === 'github-actions-mutable-action-tag')
  assert.equal(matching.length, 2)
})

test('an ignore rule missing rule or match is rejected, not silently dropped', () => {
  assert.throws(() => resolveSettings({ 'ignore-findings': [{ rule: 'x' } as never] }, inputs), /needs both/)
  assert.throws(() => resolveSettings({ 'ignore-findings': [{ match: 'y' } as never] }, inputs), /needs both/)
})

test('exclude-rules still exists for genuinely removing a whole rule', () => {
  assert.deepEqual(resolveSettings({ 'exclude-rules': ['noisy.rule'] }, inputs).excludeRules, ['noisy.rule'])
})

test('resolveSettings carries mode, severity and the gate from the config file', () => {
  const settings = resolveSettings({ mode: 'full', severity: ['ERROR'], 'fail-on-severity': 'ERROR' }, inputs)
  assert.equal(settings.mode, 'full')
  assert.equal(settings.severity, 'ERROR')
  assert.equal(settings.failOnSeverity, 'ERROR')
})

test('resolveSettings keeps the inputs for every key the config file leaves out', () => {
  const settings = resolveSettings({ rulesets: ['p/java'] }, { ...inputs, mode: 'diff' })
  assert.equal(settings.mode, 'diff')
})

test('scan-path is not settable from the config file, since it differs between jobs of one repo', () => {
  const settings = resolveSettings({ 'scan-path': 'ui' } as never, inputs)
  assert.equal('scanPath' in settings, false)
})

test('resolveSettings reads exclude-paths, defaulting to none', () => {
  assert.deepEqual(resolveSettings({ 'exclude-paths': ['**/build/**'] }, inputs).excludePaths, ['**/build/**'])
  assert.deepEqual(resolveSettings({}, inputs).excludePaths, [])
})

test('resolveSettings ignores blank and whitespace-only list entries', () => {
  const settings = resolveSettings({ rulesets: [' p/java ', '', '   '] }, inputs)
  assert.equal(settings.rulesets, 'p/java')
})

test('an empty rulesets list in the config falls back rather than scanning with nothing', () => {
  assert.equal(resolveSettings({ rulesets: [] }, inputs).rulesets, DEFAULT_RULESETS)
})

test('end to end: the shipped config shape parses and resolves', () => {
  const settings = resolveSettings(
    parseConfig(
      'rulesets:\n  - p/default\n' +
        'ignore-findings:\n  - rule: github-actions-mutable-action-tag\n    match: kestra-io/actions/\n' +
        'fail-on-severity: none\n'
    ),
    inputs
  )
  assert.equal(settings.rulesets, 'p/default')
  assert.equal(settings.failOnSeverity, 'none')
  assert.equal(settings.ignoreFindings.some(entry => entry.match === 'kestra-io/actions/'), true)
})
