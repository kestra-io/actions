import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { parseJobLog } from './github-logs.js'
import { jobSpanId, stepSpanId, traceId } from './ids.js'
import { buildResource } from './otlp.js'
import type { WorkflowJob } from './resolve-job.js'

const job: WorkflowJob = {
  id: 456,
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  runner_name: 'runner-1',
  started_at: '2026-06-20T10:00:00Z',
  completed_at: '2026-06-20T10:05:00Z',
  steps: [
    {
      name: 'Test - Gradle Check',
      status: 'completed',
      conclusion: 'success',
      number: 1,
      started_at: '2026-06-20T10:01:00Z',
      completed_at: '2026-06-20T10:04:00Z'
    }
  ]
}

const resource = buildResource('svc')

test('parses timestamped lines and assigns the trace id', () => {
  const text = '2026-06-20T10:02:00.0000000Z hello world'
  const recs = parseJobLog(text, job, traceId('123', '1'), resource)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].body, 'hello world')
  assert.equal(recs[0].spanContext?.traceId, traceId('123', '1'))
})

test('correlates a line inside a step window to the step span, else the job span', () => {
  const inStep = parseJobLog('2026-06-20T10:02:00.0000000Z during gradle', job, traceId('123', '1'), resource)
  assert.equal(inStep[0].spanContext?.spanId, stepSpanId(456, 'Test - Gradle Check'))

  const outsideStep = parseJobLog('2026-06-20T10:00:30.0000000Z setup phase', job, traceId('123', '1'), resource)
  assert.equal(outsideStep[0].spanContext?.spanId, jobSpanId(456))
})

test('maps ##[error] / ##[warning] markers to severity', () => {
  const recs = parseJobLog(
    [
      '2026-06-20T10:02:00.0000000Z ##[error]boom',
      '2026-06-20T10:02:01.0000000Z ##[warning]careful',
      '2026-06-20T10:02:02.0000000Z normal line'
    ].join('\n'),
    job,
    traceId('123', '1'),
    resource
  )
  assert.equal(recs[0].severityNumber, SeverityNumber.ERROR)
  assert.equal(recs[1].severityNumber, SeverityNumber.WARN)
  assert.equal(recs[2].severityNumber, SeverityNumber.INFO)
})

test('skips blank lines', () => {
  const recs = parseJobLog('2026-06-20T10:02:00.0000000Z line\n\n   \n', job, traceId('123', '1'), resource)
  assert.equal(recs.length, 1)
})

test('coalesces an indented stack trace into a single record', () => {
  const text = [
    '2026-06-20T10:02:00.0000000Z java.lang.AssertionError: boom',
    '2026-06-20T10:02:00.1000000Z \tat com.foo.Bar.test(Bar.java:42)',
    '2026-06-20T10:02:00.2000000Z \tat com.foo.Baz.run(Baz.java:7)',
    '2026-06-20T10:02:01.0000000Z next log line'
  ].join('\n')
  const recs = parseJobLog(text, job, traceId('123', '1'), resource)
  assert.equal(recs.length, 2)
  assert.match(String(recs[0].body), /AssertionError: boom\n\tat com\.foo\.Bar.*\n\tat com\.foo\.Baz/)
  assert.equal(recs[1].body, 'next log line')
})

test('appends untimestamped continuation lines to the previous entry', () => {
  const text = '2026-06-20T10:02:00.0000000Z header\ncontinuation without timestamp'
  const recs = parseJobLog(text, job, traceId('123', '1'), resource)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].body, 'header\ncontinuation without timestamp')
})
