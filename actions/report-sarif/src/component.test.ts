import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentOf, parseComponents } from './component.js'

const rules = parseComponents(`
  # the frontend first, the backend catches the rest
  frontend=ui/**
  frontend=ui-ee/**
  backend=**
`)

test('parses component=glob pairs in order, one component owning several globs', () => {
  assert.deepEqual(rules, [
    { component: 'frontend', glob: 'ui/**' },
    { component: 'frontend', glob: 'ui-ee/**' },
    { component: 'backend', glob: '**' }
  ])
})

test('ignores blank lines, comments and lines without a component or a glob', () => {
  assert.deepEqual(parseComponents('\n# comment\nno-separator\n=ui/**\nfrontend=\n'), [])
})

test('the first matching rule wins', () => {
  assert.equal(componentOf('ui/src/App.vue', rules), 'frontend')
  assert.equal(componentOf('ui-ee/src/App.vue', rules), 'frontend')
  assert.equal(componentOf('core/src/main/java/Flow.java', rules), 'backend')
  assert.equal(componentOf('build.gradle', rules), 'backend')
})

test('a leading ./ or file:// does not stop a path from matching', () => {
  assert.equal(componentOf('./ui/src/App.vue', rules), 'frontend')
  assert.equal(componentOf('file://ui/src/App.vue', rules), 'frontend')
})

test('no file or no matching rule gives no component', () => {
  assert.equal(componentOf(undefined, rules), undefined)
  assert.equal(componentOf('ui/src/App.vue', parseComponents('frontend=ui-ee/**')), undefined)
  assert.equal(componentOf('ui/src/App.vue', []), undefined)
})
