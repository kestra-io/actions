import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { actionRepoRoot, loadConfig, parseConfig, resolveSettings } from './config.js'

const MUTABLE_TAG =
  'yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag'

const MINIMAL = {
  rulesets: ['p/default'],
  severity: ['ERROR', 'WARNING'],
  mode: 'auto',
  'fail-on-severity': 'none'
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

// Every scan-affecting setting is required, with no fallback in code. That is what makes a local
// `opengrep scan` reproducible from the config file alone.

test('rulesets is required, since the action ships no default', () => {
  assert.throws(() => resolveSettings({ ...MINIMAL, rulesets: [] }), /must set 'rulesets'/)
  assert.throws(() => resolveSettings({ ...MINIMAL, rulesets: undefined }), /must set 'rulesets'/)
})

test('severity is required', () => {
  assert.throws(() => resolveSettings({ ...MINIMAL, severity: undefined }), /must set 'severity'/)
})

test('fail-on-severity is required, so the gate is never implicit', () => {
  assert.throws(() => resolveSettings({ ...MINIMAL, 'fail-on-severity': undefined }), /must set 'fail-on-severity'/)
})

test('mode is required', () => {
  assert.throws(() => resolveSettings({ ...MINIMAL, mode: undefined }), /must set 'mode'/)
})

test('an empty config names the first thing it is missing', () => {
  assert.throws(() => resolveSettings({}), /must set 'rulesets'/)
})

test('resolveSettings joins lists into the comma form the resolvers expect', () => {
  const settings = resolveSettings({ ...MINIMAL, rulesets: ['p/java', 'p/secrets'] })
  assert.equal(settings.rulesets, 'p/java,p/secrets')
  assert.equal(settings.severity, 'ERROR,WARNING')
})

test('resolveSettings carries mode and the gate through verbatim', () => {
  const settings = resolveSettings({ ...MINIMAL, mode: 'full', 'fail-on-severity': 'ERROR' })
  assert.equal(settings.mode, 'full')
  assert.equal(settings.failOnSeverity, 'ERROR')
})

test('resolveSettings ignores blank and whitespace-only list entries', () => {
  assert.equal(resolveSettings({ ...MINIMAL, rulesets: [' p/java ', '', '   '] }).rulesets, 'p/java')
})

test('a repository with no ignore-findings suppresses nothing', () => {
  assert.deepEqual(resolveSettings(MINIMAL).ignoreFindings, [])
})

test('exclude-paths and exclude-rules default to empty, not to a built-in list', () => {
  assert.deepEqual(resolveSettings(MINIMAL).excludePaths, [])
  assert.deepEqual(resolveSettings(MINIMAL).excludeRules, [])
})

test('suppressions come only from the config file', () => {
  const settings = resolveSettings({ ...MINIMAL, 'ignore-findings': [{ rule: 'only-mine', match: 'x' }] })
  assert.deepEqual(settings.ignoreFindings.map(e => e.rule), ['only-mine'])
})

test('the shipped config suppresses the mutable-tag rule by context, not wholesale', () => {
  const settings = resolveSettings({
    ...MINIMAL,
    'ignore-findings': [{ rule: 'github-actions-mutable-action-tag', match: 'kestra-io/actions/' }]
  })
  assert.deepEqual(settings.excludeRules, [])
  assert.equal(settings.ignoreFindings.find(e => MUTABLE_TAG.includes(e.rule))?.match, 'kestra-io/actions/')
})

test('the same suppression listed twice is collapsed, not logged twice with a misleading zero', () => {
  const rule = { rule: 'r', match: 'kestra-io/actions/' }
  assert.equal(resolveSettings({ ...MINIMAL, 'ignore-findings': [rule, rule] }).ignoreFindings.length, 1)
})

test('two suppressions for the same rule with different patterns are both kept', () => {
  const settings = resolveSettings({
    ...MINIMAL,
    'ignore-findings': [
      { rule: 'mutable-action-tag', match: 'kestra-io/actions/' },
      { rule: 'mutable-action-tag', match: 'regclient/actions/' }
    ]
  })
  assert.equal(settings.ignoreFindings.length, 2)
})

test('an ignore rule missing rule or match is rejected, not silently dropped', () => {
  assert.throws(() => resolveSettings({ ...MINIMAL, 'ignore-findings': [{ rule: 'x' } as never] }), /needs both/)
  assert.throws(() => resolveSettings({ ...MINIMAL, 'ignore-findings': [{ match: 'y' } as never] }), /needs both/)
})

test('the hyphenated match-nearest key from YAML reaches the resolved rule', () => {
  const settings = resolveSettings(
    parseConfig(
      'rulesets: [p/default]\nseverity: [ERROR]\nmode: auto\nfail-on-severity: none\n' +
        "ignore-findings:\n  - rule: r\n    match: m\n    match-nearest: '^\\s*uses:'\n    within: 5\n"
    )
  )
  const rule = settings.ignoreFindings.find(e => e.rule === 'r')
  assert.equal(rule?.matchNearest, '^\\s*uses:')
  assert.equal(rule?.within, 5)
})

// --- discovery and the kestra-io/actions fallback ------------------------------------------------

test('actionRepoRoot climbs out of actions/<name>/dist to the repository root', () => {
  const root = actionRepoRoot('file:///checkout/actions/scan-opengrep/dist/index.js')
  assert.equal(root, path.resolve('/checkout'))
})

const tmpdir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'og-cfg-'))

test('a repository config is used when present', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'own'), { recursive: true })
  await fs.writeFile(path.join(dir, 'own', 'settings.yml'), 'rulesets: [p/mine]\n')
  const loaded = await loadConfig(path.join(dir, 'own'), path.join(dir, 'fallback'))
  assert.deepEqual(loaded.config.rulesets, ['p/mine'])
  assert.equal(loaded.fromFallback, false)
})

test('the kestra-io/actions config is used when the repository has none', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'fallback'), { recursive: true })
  await fs.writeFile(path.join(dir, 'fallback', 'settings.yml'), 'rulesets: [p/default]\n')
  const loaded = await loadConfig(path.join(dir, 'missing'), path.join(dir, 'fallback'))
  assert.deepEqual(loaded.config.rulesets, ['p/default'])
  assert.equal(loaded.fromFallback, true)
})

test('a repository config wins over the fallback, rather than merging with it', async () => {
  const dir = await tmpdir()
  for (const [sub, body] of [['own', 'rulesets: [p/mine]\n'], ['fallback', 'rulesets: [p/default]\nmode: full\n']]) {
    await fs.mkdir(path.join(dir, sub!), { recursive: true })
    await fs.writeFile(path.join(dir, sub!, 'settings.yml'), body!)
  }
  const loaded = await loadConfig(path.join(dir, 'own'), path.join(dir, 'fallback'))
  assert.deepEqual(loaded.config.rulesets, ['p/mine'])
  assert.equal(loaded.config.mode, undefined)
})

test('settings.yaml is accepted as well as settings.yml', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'own'), { recursive: true })
  await fs.writeFile(path.join(dir, 'own', 'settings.yaml'), 'rulesets: [p/mine]\n')
  assert.deepEqual((await loadConfig(path.join(dir, 'own'), path.join(dir, 'none'))).config.rulesets, ['p/mine'])
})

test('with no config anywhere the action fails loudly instead of inventing defaults', async () => {
  const dir = await tmpdir()
  await assert.rejects(
    () => loadConfig(path.join(dir, 'a'), path.join(dir, 'b')),
    /No OpenGrep configuration found/
  )
})

test('a file named config.yml is ignored, since --config would reject it as a rules file', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'own'), { recursive: true })
  await fs.writeFile(path.join(dir, 'own', 'config.yml'), 'rulesets: [p/trap]\n')
  await assert.rejects(() => loadConfig(path.join(dir, 'own'), path.join(dir, 'none')), /No OpenGrep configuration found/)
})
