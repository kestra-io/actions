import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_ANNOTATIONS,
  toAnnotation,
  toAnnotations
} from './annotations.js'
import type { OpengrepResult, Severity } from './findings.js'

const result = (severity: Severity, overrides: Partial<OpengrepResult> = {}): OpengrepResult => ({
  check_id: 'java.lang.security.audit.unsafe-reflection',
  path: 'src/A.java',
  start: { line: 10, col: 5 },
  end: { line: 10, col: 40 },
  extra: { severity, message: 'unsafe reflection' },
  ...overrides
})

test('toAnnotation maps severities onto the GitHub annotation levels', () => {
  assert.equal(toAnnotation(result('ERROR')).annotation_level, 'failure')
  assert.equal(toAnnotation(result('WARNING')).annotation_level, 'warning')
  assert.equal(toAnnotation(result('INFO')).annotation_level, 'notice')
})

test('toAnnotation carries the rule id as the title and the message as the body', () => {
  const annotation = toAnnotation(result('ERROR'))
  assert.equal(annotation.title, 'java.lang.security.audit.unsafe-reflection')
  assert.equal(annotation.message, 'unsafe reflection')
  assert.equal(annotation.path, 'src/A.java')
})

test('toAnnotation keeps columns on a single-line finding', () => {
  const annotation = toAnnotation(result('ERROR'))
  assert.equal(annotation.start_column, 5)
  assert.equal(annotation.end_column, 40)
})

test('toAnnotation drops columns on a multi-line finding, which GitHub would reject', () => {
  const annotation = toAnnotation(result('ERROR', { start: { line: 10, col: 5 }, end: { line: 14, col: 2 } }))
  assert.equal(annotation.start_column, undefined)
  assert.equal(annotation.end_column, undefined)
  assert.equal(annotation.end_line, 14)
})

test('toAnnotation never lets end_line fall before start_line', () => {
  const annotation = toAnnotation(result('ERROR', { start: { line: 10 }, end: { line: 3 } }))
  assert.equal(annotation.start_line, 10)
  assert.equal(annotation.end_line, 10)
})

test('toAnnotation defaults end_line to start_line when the finding has no end', () => {
  const annotation = toAnnotation(result('ERROR', { start: { line: 7 }, end: undefined }))
  assert.equal(annotation.end_line, 7)
})

test('toAnnotations caps the list at what GitHub will store', () => {
  const results = Array.from({ length: MAX_ANNOTATIONS + 25 }, () => result('WARNING'))
  assert.equal(toAnnotations(results).length, MAX_ANNOTATIONS)
})

test('toAnnotations honours an explicit cap', () => {
  assert.equal(toAnnotations([result('ERROR'), result('ERROR')], 1).length, 1)
})
