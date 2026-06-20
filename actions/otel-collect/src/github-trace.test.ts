import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWorkflowTrace } from './github-trace.js'
import { jobSpanId, rootSpanId, stepSpanId, traceId } from './ids.js'
import { buildResource } from './otlp.js'
import type { WorkflowJob } from './resolve-job.js'

const job = (id: number, name: string): WorkflowJob => ({
  id,
  name,
  status: 'completed',
  conclusion: 'success',
  runner_name: 'runner-1',
  started_at: '2026-06-20T10:00:00Z',
  completed_at: '2026-06-20T10:05:00Z',
  steps: [
    {
      name: 'Gradle - check and javadoc',
      status: 'completed',
      conclusion: 'success',
      number: 1,
      started_at: '2026-06-20T10:00:10Z',
      completed_at: '2026-06-20T10:04:50Z'
    }
  ]
})

test('buildWorkflowTrace links root -> job -> step with deterministic ids', () => {
  const resource = buildResource('svc')
  const spans = buildWorkflowTrace([job(456, 'test')], '123', '1', 'CI', resource, Date.now())

  const tId = traceId('123', '1')
  const root = spans.find((s) => s.spanContext().spanId === rootSpanId('123', '1'))
  const jobSpan = spans.find((s) => s.spanContext().spanId === jobSpanId(456))
  const stepSpan = spans.find((s) => s.spanContext().spanId === stepSpanId(456, 'Gradle - check and javadoc'))

  assert.ok(root, 'root span present')
  assert.ok(jobSpan, 'job span present')
  assert.ok(stepSpan, 'step span present')

  // all share the trace id
  for (const s of spans) assert.equal(s.spanContext().traceId, tId)

  // hierarchy: root has no parent, job parent=root, step parent=job
  assert.equal(root.parentSpanId, undefined)
  assert.equal(jobSpan.parentSpanId, rootSpanId('123', '1'))
  assert.equal(stepSpan.parentSpanId, jobSpanId(456))
})

test('a live build span using the exported traceparent nests under the step span', () => {
  // The action exports TRACEPARENT 00-<trace>-<stepSpanId>-01; a gradle span
  // created with that parent must therefore carry the same parentSpanId the
  // post-hoc step span is built with.
  const exportedParent = stepSpanId(456, 'Gradle - check and javadoc')
  const resource = buildResource('svc')
  const spans = buildWorkflowTrace([job(456, 'test')], '123', '1', 'CI', resource, Date.now())
  const stepSpan = spans.find((s) => s.spanContext().spanId === exportedParent)
  assert.ok(stepSpan, 'the step the build runs in exists with the id used in TRACEPARENT')
})
