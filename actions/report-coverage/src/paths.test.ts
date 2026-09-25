import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCoberturaPath, toRepoPath } from './paths.js'

test('toRepoPath strips the workspace prefix', () => {
  assert.equal(toRepoPath('/home/runner/work/kestra/kestra/core/src/Foo.java', '/home/runner/work/kestra/kestra'), 'core/src/Foo.java')
})

test('toRepoPath normalizes backslashes and a leading ./', () => {
  assert.equal(toRepoPath('.\\src\\Foo.java', undefined), 'src/Foo.java')
})

test('toRepoPath drops a path outside the workspace', () => {
  assert.equal(toRepoPath('/usr/lib/foo.py', '/home/runner/work/kestra/kestra'), undefined)
  assert.equal(toRepoPath('../outside/Foo.java', undefined), undefined)
})

test('toRepoPath drops the workspace root itself and empty input', () => {
  assert.equal(toRepoPath('/home/runner/work/kestra/kestra', '/home/runner/work/kestra/kestra'), undefined)
  assert.equal(toRepoPath('', '/workspace'), undefined)
})

test('resolveCoberturaPath tries each source in order', () => {
  const sources = ['src/main', 'other/main']
  assert.equal(resolveCoberturaPath('pkg/Foo.py', sources, undefined), 'src/main/pkg/Foo.py')
})

test('resolveCoberturaPath falls back to the filename when no source resolves it', () => {
  assert.equal(resolveCoberturaPath('already/relative/Foo.py', [], undefined), 'already/relative/Foo.py')
})
