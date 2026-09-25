import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSummary } from './summary.js'

const context = { repository: 'kestra-io/kestra', component: 'backend', sha: 'abc', runId: '1' }

test('buildSummary rolls files up into modules and a grand total', () => {
  const summary = buildSummary(
    [
      { path: 'core/Foo.java', format: 'jacoco', module: 'core', lines: { covered: 8, missed: 2 } },
      { path: 'core/Bar.java', format: 'jacoco', module: 'core', lines: { covered: 3, missed: 7 }, branches: { covered: 1, missed: 1 } },
      { path: 'cli/Baz.java', format: 'jacoco', module: 'cli', lines: { covered: 5, missed: 0 } }
    ],
    context
  )

  assert.deepEqual(summary.modules.core, { lines: { covered: 11, missed: 9 }, branches: { covered: 1, missed: 1 }, functions: undefined })
  assert.deepEqual(summary.modules.cli, { lines: { covered: 5, missed: 0 }, branches: undefined, functions: undefined })
  assert.deepEqual(summary.totals.lines, { covered: 16, missed: 9 })
  assert.equal(summary.component, 'backend')
})

test('buildSummary handles no files', () => {
  const summary = buildSummary([], context)
  assert.deepEqual(summary.totals, { lines: { covered: 0, missed: 0 } })
  assert.deepEqual(summary.modules, {})
})
