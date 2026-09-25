import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubMetadata } from '../../../shared/elastic-core/src/github.js'
import { toDocument, type DocumentContext } from './documents.js'

const context: DocumentContext = {
  component: 'backend',
  namespace: 'gha',
  github: githubMetadata({
    GITHUB_REPOSITORY: 'kestra-io/kestra',
    GITHUB_REPOSITORY_OWNER: 'kestra-io',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    GITHUB_SHA: 'deadbeef',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'someone'
  }),
  scanTime: '2024-01-01T00:00:00.000Z',
  tags: ['ci'],
  metadata: { 'service.name': 'kestra' }
}

const file = { path: 'core/src/main/java/io/kestra/core/Foo.java', format: 'jacoco' as const, module: 'core', lines: { covered: 8, missed: 2 } }

test('toDocument shapes one document per file with module, language and a stable id', () => {
  const document = toDocument(file, context) as any
  assert.equal(document.coverage.module, 'core')
  assert.equal(document.coverage.lines.pct, 80)
  assert.equal(document.code.language, 'java')
  assert.equal(document.file.path, 'core/src/main/java/io/kestra/core/Foo.java')
  assert.equal(document.resource.url, 'https://github.com/kestra-io/kestra/blob/deadbeef/core/src/main/java/io/kestra/core/Foo.java')
  assert.equal(document.labels, undefined)
  assert.equal(document.service.name, 'kestra')
})

test('toDocument ids the same file identically across two builds of the same run', () => {
  assert.equal((toDocument(file, context) as any).event.id, (toDocument(file, context) as any).event.id)
})

test('toDocument ids differ per file and per component', () => {
  const other = { ...file, path: 'core/src/main/java/io/kestra/core/Bar.java' }
  assert.notEqual((toDocument(file, context) as any).event.id, (toDocument(other, context) as any).event.id)
  const otherComponent = toDocument(file, { ...context, component: 'frontend' }) as any
  assert.notEqual((toDocument(file, context) as any).event.id, otherComponent.event.id)
})

test('branches and functions are omitted when the report did not carry them', () => {
  const document = toDocument(file, context) as any
  assert.equal(document.coverage.branches, undefined)
  assert.equal(document.coverage.functions, undefined)
})
