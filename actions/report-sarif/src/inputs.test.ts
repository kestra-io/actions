import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBoolean, parseList, parsePairs } from './inputs.js'

test('parsePairs reads a multi-line key=value input', () => {
  assert.deepEqual(parsePairs('team=security\n service.name = kestra-ee \n\n# a comment\nbad-line'), {
    team: 'security',
    'service.name': 'kestra-ee'
  })
})

test('parsePairs keeps separators inside the value', () => {
  assert.deepEqual(parsePairs('url=https://example.invalid/a=b'), { url: 'https://example.invalid/a=b' })
})

test('parseList trims and drops empties', () => {
  assert.deepEqual(parseList(' ci , security ,, '), ['ci', 'security'])
  assert.deepEqual(parseList(''), [])
})

test('parseBoolean falls back on anything that is not true or false', () => {
  assert.equal(parseBoolean('true'), true)
  assert.equal(parseBoolean(' TRUE '), true)
  assert.equal(parseBoolean('false'), false)
  assert.equal(parseBoolean(''), false)
  assert.equal(parseBoolean('', true), true)
})
