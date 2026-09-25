import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildComment } from './comment.js'
import type { CoverageSummary } from './summary.js'

const context = { repository: 'kestra-io/kestra', component: 'backend', sha: 'abc', runId: '1' }

function summary(modules: CoverageSummary['modules']): CoverageSummary {
  const totals = Object.values(modules).reduce(
    (acc, m) => ({ lines: { covered: acc.lines.covered + m.lines.covered, missed: acc.lines.missed + m.lines.missed } }),
    { lines: { covered: 0, missed: 0 } }
  )
  return { ...context, modules, totals }
}

test('buildComment shows the overall percentage with no delta when there is no baseline', () => {
  const current = summary({ core: { lines: { covered: 8, missed: 2 } } })
  const markdown = buildComment(current, undefined)
  assert.match(markdown, /\*\*80\.00%\*\* line coverage/)
  assert.match(markdown, /No develop baseline yet/)
  assert.doesNotMatch(markdown, /pp\)/)
})

test('buildComment shows the delta against a baseline, with an arrow', () => {
  const current = summary({ core: { lines: { covered: 9, missed: 1 } } })
  const base = summary({ core: { lines: { covered: 8, missed: 2 } } })
  const markdown = buildComment(current, base)
  assert.match(markdown, /▲ \+10\.00pp/)
})

test('buildComment marks a module absent from the current run as removed, and a new one as new', () => {
  const current = summary({ cli: { lines: { covered: 5, missed: 0 } } })
  const base = summary({ core: { lines: { covered: 8, missed: 2 } } })
  const markdown = buildComment(current, base)
  assert.match(markdown, /\| core \| — \| removed \| — \|/)
  assert.match(markdown, /\| cli \(new\)/)
})

test('buildComment collapses the module table above the threshold', () => {
  const modules: CoverageSummary['modules'] = {}
  for (let i = 0; i < 20; i++) modules[`m${i}`] = { lines: { covered: 1, missed: 0 } }
  const markdown = buildComment(summary(modules), undefined)
  assert.match(markdown, /<details>/)
})
