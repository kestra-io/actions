import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMetadata, prune, setPath } from './document.js'

test('setPath builds nested objects and overwrites a non-object on the way', () => {
  const target: Record<string, unknown> = { a: 'scalar' }
  setPath(target, 'a.b.c', 1)
  assert.deepEqual(target, { a: { b: { c: 1 } } })
})

test('applyMetadata writes dotted keys at their path and the rest under labels', () => {
  const document: Record<string, unknown> = {}
  applyMetadata(document, { 'service.name': 'kestra', team: 'core' })
  assert.deepEqual(document, { service: { name: 'kestra' }, labels: { team: 'core' } })
})

test('prune drops empty values and the objects they leave empty', () => {
  assert.deepEqual(prune({ a: '', b: [], c: { d: undefined }, e: 0, f: 'x' }), { e: 0, f: 'x' })
})
