import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { jobSpanId, rootSpanId, stepSpanId, traceId } from './ids.js'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

test('traceId is the first 16 bytes of sha256(run+attempt+t)', () => {
  assert.equal(traceId('123', '1'), sha('1231t').slice(0, 32))
  assert.equal(traceId('123', '1').length, 32)
})

test('rootSpanId is bytes [16:32] of sha256(run+attempt+s)', () => {
  assert.equal(rootSpanId('123', '1'), sha('1231s').slice(16, 32))
  assert.equal(rootSpanId('123', '1').length, 16)
})

test('jobSpanId is bytes [16:32] of sha256(jobId-j)', () => {
  assert.equal(jobSpanId(456), sha('456-j').slice(16, 32))
  assert.equal(jobSpanId(456).length, 16)
})

test('stepSpanId is bytes [16:32] of sha256(jobId-step-s)', () => {
  assert.equal(stepSpanId(456, 'Gradle - check and javadoc'), sha('456-Gradle - check and javadoc-s').slice(16, 32))
  assert.equal(stepSpanId(456, 'Gradle - check and javadoc').length, 16)
})

test('ids are deterministic and attempt-sensitive', () => {
  assert.equal(traceId('123', '1'), traceId('123', '1'))
  assert.notEqual(traceId('123', '1'), traceId('123', '2'))
})
