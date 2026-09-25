import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  datasetForTool,
  firstSentence,
  humaniseRuleId,
  isBoilerplateTitle,
  languageOf,
  rationaleOf,
  ruleSection,
  ruleTitle
} from './finding.js'

test('the "<Tool> Finding:" boilerplate is recognised', () => {
  // What OpenGrep actually wrote into the cluster: the id in it is a runner temp path.
  assert.equal(isBoilerplateTitle('Opengrep Finding: home.runner.work._temp.kestra-mutable-action-tag'), true)
  assert.equal(isBoilerplateTitle('Semgrep Finding: rules.foo'), true)
  assert.equal(isBoilerplateTitle('guava: insecure temporary directory creation'), false)
  assert.equal(isBoilerplateTitle('Detected non-constant command with Runtime.exec()'), false)
})

test('humaniseRuleId takes the specific segment and drops the repeat', () => {
  assert.equal(
    humaniseRuleId('dockerfile.security.missing-user-entrypoint.missing-user-entrypoint'),
    'Missing user entrypoint'
  )
  assert.equal(humaniseRuleId('kestra-mutable-action-tag'), 'Kestra mutable action tag')
  assert.equal(
    humaniseRuleId('java.lang.security.audit.command-injection-formatted-runtime-call'),
    'Command injection formatted runtime call'
  )
})

test('firstSentence only offers a sentence short enough to read as a title', () => {
  assert.equal(firstSentence('Pin this action to a SHA. A tag can be repointed.'), 'Pin this action to a SHA.')
  assert.equal(firstSentence('No trailing punctuation here'), 'No trailing punctuation here')
  assert.equal(firstSentence(`${'x'.repeat(200)}.`), '', 'too long to be a title')
  assert.equal(firstSentence('   '), '')
})

test('ruleTitle prefers what a human wrote, then the description, then the id', () => {
  assert.equal(ruleTitle('guava: insecure temp dir', 'Long description.', 'CVE-1'), 'guava: insecure temp dir')
  // The real case: boilerplate title, useful description.
  assert.equal(
    ruleTitle(
      'Opengrep Finding: home.runner.work._temp.kestra-mutable-action-tag',
      'Pin this action to a full 40-character commit SHA. A tag or branch can be repointed by its owner.',
      'kestra-mutable-action-tag'
    ),
    'Pin this action to a full 40-character commit SHA.'
  )
  // Boilerplate title and a description too long to be one either.
  assert.equal(
    ruleTitle('Opengrep Finding: x', `${'y'.repeat(200)}.`, 'dockerfile.security.missing-user-entrypoint'),
    'Missing user entrypoint'
  )
  assert.equal(ruleTitle('', '', 'some.rule-id'), 'Rule id')
  assert.equal(ruleTitle('CVE-1', 'desc.', 'CVE-1'), 'desc.', 'a title echoing the id is no title')
})

test('datasetForTool gives each scanner its own dash-free dataset', () => {
  assert.equal(datasetForTool('Opengrep OSS'), 'opengrep')
  assert.equal(datasetForTool('Trivy'), 'trivy')
  assert.equal(datasetForTool(''), 'unknown')
})

test('languageOf names the kind of file, not just its extension', () => {
  assert.equal(languageOf('Dockerfile'), 'dockerfile')
  assert.equal(languageOf('docker/Dockerfile.ci'), 'dockerfile')
  assert.equal(languageOf('pom.xml'), 'maven')
  assert.equal(languageOf('.github/workflows/publish.yml'), 'yaml')
  assert.equal(languageOf('core/src/main/java/Foo.java'), 'java')
  assert.equal(languageOf('ui/src/App.vue'), 'vue')
  assert.equal(languageOf('build/libs/plugin.jar'), 'jar')
  assert.equal(languageOf('README'), undefined)
  assert.equal(languageOf(undefined), undefined)
})

test('ruleSection prefers OWASP, then CWE text, then the id namespace', () => {
  assert.equal(ruleSection(['OWASP-A01:2017 - Injection', 'security'], 'x.y'), 'OWASP A01:2017 - Injection')
  assert.equal(ruleSection(['CWE-269: Improper Privilege Management'], 'x.y'), 'Improper Privilege Management')
  assert.equal(ruleSection(['security'], 'dockerfile.security.missing-user'), 'Dockerfile')
  assert.equal(ruleSection([], 'kestra-mutable-action-tag'), undefined, 'an id with no namespace has no section')
})

test('rationaleOf is the explanation after the opening statement', () => {
  assert.equal(
    rationaleOf('Pin this action to a SHA. A tag can be repointed by its owner, so the code differs.'),
    'A tag can be repointed by its owner, so the code differs.'
  )
  assert.equal(rationaleOf('Only one sentence here.'), undefined)
  assert.equal(rationaleOf(''), undefined)
})
