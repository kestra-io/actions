import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { actionRepoRoot, loadConfig, parseConfig, resolveSettings, shortRuleIds } from './config.js'

const MUTABLE_TAG =
  'yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag'

test('parseConfig reads a mapping', () => {
  assert.deepEqual(parseConfig('rulesets:\n  - p/java\n'), { rulesets: ['p/java'] })
})

test('parseConfig treats an empty or comment-only file as no settings', () => {
  assert.deepEqual(parseConfig(''), {})
  assert.deepEqual(parseConfig('# nothing here\n'), {})
})

test('parseConfig rejects a file that is not a mapping, rather than ignoring it', () => {
  assert.throws(() => parseConfig('- p/java\n'), /must be a YAML mapping/)
  assert.throws(() => parseConfig('just a string\n'), /must be a YAML mapping/)
})

test('settings must provide something to scan with', () => {
  assert.throws(() => resolveSettings({}), /must set 'rulesets' or 'rules'/)
  assert.throws(() => resolveSettings({ rulesets: [] }), /must set 'rulesets' or 'rules'/)
})

test('rules alone are enough, for a repository opting out of the registry', () => {
  const settings = resolveSettings({ rules: [{ id: 'mine' }] })
  assert.equal(settings.rulesets, '')
  assert.equal(settings.rules.length, 1)
})

test('resolveSettings joins rulesets into the comma form the resolver expects', () => {
  assert.equal(resolveSettings({ rulesets: ['p/java', 'p/secrets'] }).rulesets, 'p/java,p/secrets')
})

test('resolveSettings ignores blank and whitespace-only list entries', () => {
  assert.equal(resolveSettings({ rulesets: [' p/java ', '', '   '] }).rulesets, 'p/java')
})

test('exclude-rules and exclude-paths default to empty, not to a built-in list', () => {
  const settings = resolveSettings({ rulesets: ['p/default'] })
  assert.deepEqual(settings.excludeRules, [])
  assert.deepEqual(settings.excludePaths, [])
  assert.deepEqual(settings.rules, [])
})

test('exclude-rules and exclude-paths are carried through, deduplicated', () => {
  const settings = resolveSettings({
    rulesets: ['p/default'],
    'exclude-rules': [MUTABLE_TAG, MUTABLE_TAG],
    'exclude-paths': ['**/src/test/**', '**/src/test/**']
  })
  assert.deepEqual(settings.excludeRules, [MUTABLE_TAG])
  assert.deepEqual(settings.excludePaths, ['**/src/test/**'])
})

// --exclude-rule matches the whole id, so a short name silently drops nothing. That failure is
// invisible in the output, which is why it is warned about rather than left to be discovered.

test('shortRuleIds flags a dot-less id, which --exclude-rule would ignore', () => {
  assert.deepEqual(shortRuleIds(['github-actions-mutable-action-tag']), ['github-actions-mutable-action-tag'])
})

test('shortRuleIds passes a full dotted registry id', () => {
  assert.deepEqual(shortRuleIds([MUTABLE_TAG]), [])
})

test('shortRuleIds reports only the offending entries', () => {
  assert.deepEqual(shortRuleIds([MUTABLE_TAG, 'short-one']), ['short-one'])
})

// --- discovery and the kestra-io/actions fallback ------------------------------------------------

test('actionRepoRoot climbs out of actions/<name>/dist to the repository root', () => {
  assert.equal(actionRepoRoot('file:///checkout/actions/scan-opengrep/dist/index.js'), path.resolve('/checkout'))
})

const tmpdir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'og-cfg-'))

test('a repository settings file is used when present', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'own'), { recursive: true })
  await fs.writeFile(path.join(dir, 'own', 'settings.yml'), 'rulesets: [p/mine]\n')
  const loaded = await loadConfig(path.join(dir, 'own'), path.join(dir, 'fallback'))
  assert.deepEqual(loaded.config.rulesets, ['p/mine'])
  assert.equal(loaded.fromFallback, false)
})

test('the kestra-io/actions settings are used when the repository has none', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'fallback'), { recursive: true })
  await fs.writeFile(path.join(dir, 'fallback', 'settings.yml'), 'rulesets: [p/default]\n')
  const loaded = await loadConfig(path.join(dir, 'missing'), path.join(dir, 'fallback'))
  assert.deepEqual(loaded.config.rulesets, ['p/default'])
  assert.equal(loaded.fromFallback, true)
})

test('a repository settings file wins over the fallback, rather than merging with it', async () => {
  const dir = await tmpdir()
  for (const [sub, body] of [['own', 'rulesets: [p/mine]\n'], ['fallback', 'rulesets: [p/default]\nexclude-paths: [x]\n']]) {
    await fs.mkdir(path.join(dir, sub!), { recursive: true })
    await fs.writeFile(path.join(dir, sub!, 'settings.yml'), body!)
  }
  const loaded = await loadConfig(path.join(dir, 'own'), path.join(dir, 'fallback'))
  assert.deepEqual(loaded.config.rulesets, ['p/mine'])
  assert.equal(loaded.config['exclude-paths'], undefined)
})

test('settings.yaml is accepted as well as settings.yml', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'own'), { recursive: true })
  await fs.writeFile(path.join(dir, 'own', 'settings.yaml'), 'rulesets: [p/mine]\n')
  assert.deepEqual((await loadConfig(path.join(dir, 'own'), path.join(dir, 'none'))).config.rulesets, ['p/mine'])
})

test('a file named config.yml is ignored, since --config would reject it as a rules file', async () => {
  const dir = await tmpdir()
  await fs.mkdir(path.join(dir, 'own'), { recursive: true })
  await fs.writeFile(path.join(dir, 'own', 'config.yml'), 'rulesets: [p/trap]\n')
  await assert.rejects(() => loadConfig(path.join(dir, 'own'), path.join(dir, 'none')), /No OpenGrep settings found/)
})

test('with no settings anywhere the action fails loudly instead of inventing defaults', async () => {
  const dir = await tmpdir()
  await assert.rejects(() => loadConfig(path.join(dir, 'a'), path.join(dir, 'b')), /No OpenGrep settings found/)
})
