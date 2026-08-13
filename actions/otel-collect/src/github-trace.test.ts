import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWorkflowTrace } from './github-trace.js'
import { jobSpanId, rootSpanId, stepSpanId, traceId } from './ids.js'
import type { WorkflowJob } from './resolve-job.js'

const job = (id: number, name: string): WorkflowJob => ({
  id,
  name,
  status: 'completed',
  conclusion: 'success',
  runner_name: 'runner-1',
  labels: ['self-hosted'],
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
  const spans = buildWorkflowTrace([job(456, 'test')], '123', '1', 'CI', 'svc', Date.now())

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
  assert.equal(root.parentSpanContext, undefined)
  assert.equal(jobSpan.parentSpanContext?.spanId, rootSpanId('123', '1'))
  assert.equal(stepSpan.parentSpanContext?.spanId, jobSpanId(456))

  // every GitHub Actions layer span is tagged so it's distinguishable from the
  // gradle/junit spans that nest under the step span, which carry their own
  // service.name (see gradle.test.ts) and telemetry.source values.
  for (const s of [root, jobSpan, stepSpan]) assert.equal(s.attributes['telemetry.source'], 'github-actions')
})

test('buildWorkflowTrace excludes skipped jobs', () => {
  const skippedJob: WorkflowJob = {
    ...job(789, 'skipped-job'),
    conclusion: 'skipped',
    started_at: null,
    completed_at: null
  }
  const spans = buildWorkflowTrace([job(456, 'test'), skippedJob], '123', '1', 'CI', 'svc', Date.now())

  const skippedJobSpan = spans.find((s) => s.spanContext().spanId === jobSpanId(789))
  assert.equal(skippedJobSpan, undefined, 'skipped job span should not be exported')

  const ranJobSpan = spans.find((s) => s.spanContext().spanId === jobSpanId(456))
  assert.ok(ranJobSpan, 'non-skipped job span still present')
})

test('job and step spans get a job-scoped instance id; the root span gets a run-level one', () => {
  const prev = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT }
  process.env.GITHUB_RUN_ID = '123'
  process.env.GITHUB_RUN_ATTEMPT = '1'
  try {
    const spans = buildWorkflowTrace([job(456, 'test')], '123', '1', 'CI', 'svc', Date.now())
    const root = spans.find((s) => s.spanContext().spanId === rootSpanId('123', '1'))
    const jobSpan = spans.find((s) => s.spanContext().spanId === jobSpanId(456))

    assert.equal(root?.resource.attributes['service.instance.id'], 'Workflow 123 - Attempt 1')
    assert.equal(jobSpan?.resource.attributes['service.instance.id'], 'Workflow 123 - Job 456 - Attempt 1')
  } finally {
    if (prev.id === undefined) delete process.env.GITHUB_RUN_ID
    else process.env.GITHUB_RUN_ID = prev.id
    if (prev.attempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = prev.attempt
  }
})

test('job and step spans get host.name from the job\'s own runner_name, not this process\'s RUNNER_NAME', () => {
  const prev = process.env.RUNNER_NAME
  try {
    // The current process's runner (e.g. the export-all aggregation job) must not
    // leak onto another job's spans.
    process.env.RUNNER_NAME = 'aggregator-runner'
    const spans = buildWorkflowTrace([job(456, 'test')], '123', '1', 'CI', 'svc', Date.now())
    const jobSpan = spans.find((s) => s.spanContext().spanId === jobSpanId(456))
    assert.equal(jobSpan?.resource.attributes['host.name'], 'runner-1')
  } finally {
    if (prev === undefined) delete process.env.RUNNER_NAME
    else process.env.RUNNER_NAME = prev
  }
})

test('job and step spans get github.runner_environment from the job\'s own labels, not this process\'s RUNNER_ENVIRONMENT', () => {
  const prev = process.env.RUNNER_ENVIRONMENT
  try {
    // A workflow run can mix self-hosted and github-hosted jobs; the aggregator's
    // own flavour must not leak onto another job's spans.
    process.env.RUNNER_ENVIRONMENT = 'github-hosted'
    const selfHosted = job(456, 'test')
    const spans = buildWorkflowTrace([selfHosted], '123', '1', 'CI', 'svc', Date.now())
    const jobSpan = spans.find((s) => s.spanContext().spanId === jobSpanId(456))
    assert.equal(jobSpan?.resource.attributes['github.runner_environment'], 'self-hosted')

    const hosted: WorkflowJob = { ...job(789, 'test2'), labels: ['ubuntu-latest'] }
    const hostedSpans = buildWorkflowTrace([hosted], '123', '1', 'CI', 'svc', Date.now())
    const hostedJobSpan = hostedSpans.find((s) => s.spanContext().spanId === jobSpanId(789))
    assert.equal(hostedJobSpan?.resource.attributes['github.runner_environment'], 'github-hosted')
  } finally {
    if (prev === undefined) delete process.env.RUNNER_ENVIRONMENT
    else process.env.RUNNER_ENVIRONMENT = prev
  }
})

test('a live build span using the exported traceparent nests under the step span', () => {
  // The action exports TRACEPARENT 00-<trace>-<stepSpanId>-01; a gradle span
  // created with that parent must therefore carry the same parentSpanId the
  // post-hoc step span is built with.
  const exportedParent = stepSpanId(456, 'Gradle - check and javadoc')
  const spans = buildWorkflowTrace([job(456, 'test')], '123', '1', 'CI', 'svc', Date.now())
  const stepSpan = spans.find((s) => s.spanContext().spanId === exportedParent)
  assert.ok(stepSpan, 'the step the build runs in exists with the id used in TRACEPARENT')
})
