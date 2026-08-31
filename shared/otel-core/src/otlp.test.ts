import assert from 'node:assert/strict'
import * as os from 'node:os'
import { test } from 'node:test'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { baseEndpoint, buildResource, chunkLogs, grpcTarget, parseHeaders, serviceInstanceId } from './otlp.js'

function fakeRecord(bodyLen: number): ReadableLogRecord {
  return { body: 'x'.repeat(bodyLen), attributes: {} } as unknown as ReadableLogRecord
}

test('grpcTarget strips scheme and signal path, defaults TLS port', () => {
  assert.deepEqual(grpcTarget('https://otlp.example.com/v1/traces'), { target: 'otlp.example.com:443', secure: true })
  assert.deepEqual(grpcTarget('https://otlp.example.com'), { target: 'otlp.example.com:443', secure: true })
  assert.deepEqual(grpcTarget('https://otlp.example.com:4317'), { target: 'otlp.example.com:4317', secure: true })
  assert.deepEqual(grpcTarget('http://localhost:4317'), { target: 'localhost:4317', secure: false })
  assert.deepEqual(grpcTarget('http://localhost'), { target: 'localhost:4317', secure: false })
})

test('baseEndpoint returns scheme + host[:port] with no path', () => {
  assert.equal(baseEndpoint('https://otlp.example.com/v1/traces'), 'https://otlp.example.com:443')
  assert.equal(baseEndpoint('http://localhost:4317/v1/metrics'), 'http://localhost:4317')
})

test('serviceInstanceId is readable and scoped to a job when given one, else falls back to run-level', () => {
  const prev = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, runner: process.env.RUNNER_NAME }
  try {
    process.env.GITHUB_RUN_ID = '12345'
    process.env.GITHUB_RUN_ATTEMPT = '2'
    assert.equal(serviceInstanceId(789), 'Workflow 12345 - Job 789 - Attempt 2')
    assert.equal(serviceInstanceId(), 'Workflow 12345 - Attempt 2')

    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    process.env.RUNNER_NAME = 'runner-7'
    assert.equal(serviceInstanceId(), 'runner-7')
  } finally {
    if (prev.id === undefined) delete process.env.GITHUB_RUN_ID
    else process.env.GITHUB_RUN_ID = prev.id
    if (prev.attempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = prev.attempt
    if (prev.runner === undefined) delete process.env.RUNNER_NAME
    else process.env.RUNNER_NAME = prev.runner
  }
})

test('buildResource sets host.name to RUNNER_NAME, matching the hostmetrics collector', () => {
  const prev = process.env.RUNNER_NAME
  try {
    process.env.RUNNER_NAME = 'GitHub Actions 7'
    const resource = buildResource('svc')
    assert.equal(resource.attributes['host.name'], 'GitHub Actions 7')
  } finally {
    if (prev === undefined) delete process.env.RUNNER_NAME
    else process.env.RUNNER_NAME = prev
  }
})

test('buildResource falls back to the OS hostname when RUNNER_NAME is unset', () => {
  const prev = process.env.RUNNER_NAME
  try {
    delete process.env.RUNNER_NAME
    const resource = buildResource('svc')
    assert.equal(resource.attributes['host.name'], os.hostname())
  } finally {
    if (prev === undefined) delete process.env.RUNNER_NAME
    else process.env.RUNNER_NAME = prev
  }
})

test('buildResource tags the resource with the job id when given one', () => {
  const withJob = buildResource('svc', 789)
  assert.equal(withJob.attributes['github.job_id'], '789')

  const withoutJob = buildResource('svc')
  assert.equal(withoutJob.attributes['github.job_id'], '')
})

test('buildResource reads github.runner_environment from RUNNER_ENVIRONMENT', () => {
  const prev = process.env.RUNNER_ENVIRONMENT
  try {
    process.env.RUNNER_ENVIRONMENT = 'github-hosted'
    assert.equal(buildResource('svc').attributes['github.runner_environment'], 'github-hosted')

    delete process.env.RUNNER_ENVIRONMENT
    assert.equal(buildResource('svc').attributes['github.runner_environment'], '')
  } finally {
    if (prev === undefined) delete process.env.RUNNER_ENVIRONMENT
    else process.env.RUNNER_ENVIRONMENT = prev
  }
})

test('buildResource prefers the given workflowName over GITHUB_WORKFLOW', () => {
  const prev = process.env.GITHUB_WORKFLOW
  try {
    process.env.GITHUB_WORKFLOW = 'Main Workflow'
    assert.equal(
      buildResource('svc', undefined, undefined, undefined, 'Frontend tests').attributes['github.workflow.name'],
      'Frontend tests'
    )
    assert.equal(buildResource('svc').attributes['github.workflow.name'], 'Main Workflow')
  } finally {
    if (prev === undefined) delete process.env.GITHUB_WORKFLOW
    else process.env.GITHUB_WORKFLOW = prev
  }
})

test('parseHeaders splits comma-separated k=v pairs', () => {
  assert.deepEqual(parseHeaders('Authorization=ApiKey abc,x-tenant=foo'), {
    Authorization: 'ApiKey abc',
    'x-tenant': 'foo'
  })
  assert.deepEqual(parseHeaders(''), {})
})

test('chunkLogs keeps small logs in a single batch', () => {
  const logs = [fakeRecord(10), fakeRecord(10), fakeRecord(10)]
  assert.deepEqual(chunkLogs(logs, 1000), [logs])
})

test('chunkLogs splits once the running size would exceed the limit', () => {
  const logs = [fakeRecord(100), fakeRecord(100), fakeRecord(100)]
  const batches = chunkLogs(logs, 250)
  assert.equal(batches.length, 3)
  for (const batch of batches) assert.equal(batch.length, 1)
})

test('chunkLogs never produces an empty batch, even for an oversized single record', () => {
  const logs = [fakeRecord(10), fakeRecord(1000), fakeRecord(10)]
  const batches = chunkLogs(logs, 100)
  assert.equal(batches.flat().length, 3)
  for (const batch of batches) assert.ok(batch.length > 0)
})

test('chunkLogs returns no batches for an empty input', () => {
  assert.deepEqual(chunkLogs([], 1000), [])
})
