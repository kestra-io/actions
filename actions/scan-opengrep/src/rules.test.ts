import assert from 'node:assert/strict'
import * as path from 'node:path'
import { test } from 'node:test'
import { buildRuleset, resolveRulesets } from './rules.js'

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

test('resolveRulesets rejects a ref with shell-hostile characters', () => {
  assert.throws(() => resolveRulesets('p/java; rm -rf /'), /Invalid ruleset/)
  assert.throws(() => resolveRulesets('p/java$(whoami)'), /Invalid ruleset/)
})

test('resolveRulesets rejects an empty input rather than scanning with no rules', () => {
  assert.throws(() => resolveRulesets(''), /No OpenGrep rulesets resolved/)
  assert.throws(() => resolveRulesets('  , '), /No OpenGrep rulesets resolved/)
})

test('an unresolvable pack is passed through; the registry 404 is the error, not a guess here', () => {
  assert.deepEqual(resolveRulesets('vue').rulesets, ['p/vue'])
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
