import assert from 'node:assert/strict'
import { test } from 'node:test'
import { languageOf } from './language.js'

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
