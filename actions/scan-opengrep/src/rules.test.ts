import assert from 'node:assert/strict'
import * as path from 'node:path'
import { test } from 'node:test'
import { buildRuleset, resolveRulesets } from './rules.js'
import { KNOWN_PACKS } from './version.js'

test('resolveRulesets expands a bare word into a registry pack', () => {
  assert.deepEqual(resolveRulesets('java').rulesets, ['p/java'])
})

test('resolveRulesets leaves an explicit p/ ref alone', () => {
  assert.deepEqual(resolveRulesets('p/security-audit').rulesets, ['p/security-audit'])
})

test('resolveRulesets keeps a path-shaped ref as a local config', () => {
  assert.deepEqual(resolveRulesets('./rules/my.yaml').rulesets, ['./rules/my.yaml'])
  assert.deepEqual(resolveRulesets('my-rule.yml').rulesets, ['my-rule.yml'])
})

test('resolveRulesets parses a comma-separated list in order', () => {
  assert.deepEqual(resolveRulesets('p/java, p/secrets ,docker').rulesets, ['p/java', 'p/secrets', 'p/docker'])
})

test('resolveRulesets deduplicates', () => {
  assert.deepEqual(resolveRulesets('java,p/java,java').rulesets, ['p/java'])
})

test('resolveRulesets reports unknown packs as a warning signal, not an error', () => {
  const { rulesets, unknown } = resolveRulesets('p/java,p/not-a-real-pack')
  assert.deepEqual(rulesets, ['p/java', 'p/not-a-real-pack'])
  assert.deepEqual(unknown, ['p/not-a-real-pack'])
})

test('resolveRulesets does not flag packs that are known to resolve', () => {
  assert.deepEqual(resolveRulesets('p/default,p/secrets').unknown, [])
})

test('resolveRulesets does not flag local paths as unknown packs', () => {
  assert.deepEqual(resolveRulesets('./my-rules/x.yaml').unknown, [])
})

test('resolveRulesets rejects a ref with shell-hostile characters', () => {
  assert.throws(() => resolveRulesets('p/java; rm -rf /'), /Invalid ruleset/)
  assert.throws(() => resolveRulesets('p/java$(whoami)'), /Invalid ruleset/)
})

test('resolveRulesets rejects an empty input rather than scanning with no rules', () => {
  assert.throws(() => resolveRulesets(''), /No OpenGrep rulesets resolved/)
  assert.throws(() => resolveRulesets('  , '), /No OpenGrep rulesets resolved/)
})

test('p/vue is not a known pack, so asking for it warns before the scan tries to fetch it', () => {
  assert.equal((KNOWN_PACKS as readonly string[]).includes('p/vue'), false)
  assert.deepEqual(resolveRulesets('vue').unknown, ['p/vue'])
})

test('buildRuleset passes registry refs through with no rule-id root to strip', () => {
  const ruleset = buildRuleset(['p/java', 'p/secrets'], null)
  assert.deepEqual(ruleset.configs, ['p/java', 'p/secrets'])
  assert.equal(ruleset.root, '')
  assert.equal(ruleset.source, 'registry')
})

test('buildRuleset adds repository rules alongside the registry, not instead of it', () => {
  const ruleset = buildRuleset(['p/java'], '.opengrep/rules')
  assert.deepEqual(ruleset.configs, ['p/java', path.resolve('.opengrep/rules')])
  assert.equal(ruleset.source, 'registry+local')
})

test('buildRuleset reports local-only when a repository opts out of the registry', () => {
  const ruleset = buildRuleset([], '.opengrep/rules')
  assert.deepEqual(ruleset.configs, [path.resolve('.opengrep/rules')])
  assert.equal(ruleset.source, 'local')
  assert.equal(path.isAbsolute(ruleset.root), true)
})
