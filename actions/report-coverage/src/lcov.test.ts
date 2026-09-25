import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLcov } from './lcov.js'

const FIXTURE = [
  'TN:',
  'SF:/workspace/src/foo.ts',
  'FNF:2',
  'FNH:1',
  'BRF:4',
  'BRH:2',
  'LF:10',
  'LH:8',
  'end_of_record',
  'TN:',
  'SF:/workspace/src/bar.ts',
  'LF:5',
  'LH:5',
  'end_of_record',
  ''
].join('\n')

test('parseLcov reads line, branch and function counters per file', () => {
  const files = parseLcov(FIXTURE, '/workspace')
  assert.deepEqual(files, [
    { path: 'src/foo.ts', format: 'lcov', lines: { covered: 8, missed: 2 }, branches: { covered: 2, missed: 2 }, functions: { covered: 1, missed: 1 } },
    { path: 'src/bar.ts', format: 'lcov', lines: { covered: 5, missed: 0 }, branches: undefined, functions: undefined }
  ])
})

test('parseLcov flushes a trace missing its end_of_record terminator', () => {
  const files = parseLcov('SF:/workspace/src/foo.ts\nLF:1\nLH:1\n', '/workspace')
  assert.deepEqual(files, [{ path: 'src/foo.ts', format: 'lcov', lines: { covered: 1, missed: 0 }, branches: undefined, functions: undefined }])
})

test('parseLcov drops a record whose path resolves outside the workspace', () => {
  assert.deepEqual(parseLcov('SF:/other/src/foo.ts\nLF:1\nLH:1\nend_of_record\n', '/workspace'), [])
})
