import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addCounter, mergeCounter, pct, total } from './model.js'

test('total sums covered and missed', () => {
  assert.equal(total({ covered: 3, missed: 2 }), 5)
})

test('pct is 0 rather than NaN when there is nothing to cover', () => {
  assert.equal(pct({ covered: 0, missed: 0 }), 0)
  assert.equal(pct({ covered: 1, missed: 3 }), 25)
})

test('addCounter adds both fields', () => {
  assert.deepEqual(addCounter({ covered: 1, missed: 2 }, { covered: 3, missed: 0 }), { covered: 4, missed: 2 })
})

test('mergeCounter keeps the fuller counter rather than adding them', () => {
  assert.deepEqual(mergeCounter({ covered: 5, missed: 5 }, { covered: 8, missed: 2 }), { covered: 8, missed: 2 })
  assert.deepEqual(mergeCounter(undefined, { covered: 1, missed: 1 }), { covered: 1, missed: 1 })
  assert.deepEqual(mergeCounter({ covered: 1, missed: 1 }, undefined), { covered: 1, missed: 1 })
})
