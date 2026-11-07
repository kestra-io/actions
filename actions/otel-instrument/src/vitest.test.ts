import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { stepSpanId } from '../../../shared/otel-core/src/ids.js'
import { exportVitestSpans } from './vitest.js'
import OtelVitestReporter, { resolveParent, type VitestSpanFile } from './vitest-reporter.js'

const TRACE_ID = '0123456789abcdef0123456789abcdef'

test('resolveParent prefers OTEL_STEP_NAME over TRACEPARENT', () => {
  const traceparent = `00-${TRACE_ID}-aaaaaaaaaaaaaaaa-01`
  assert.deepEqual(resolveParent({ TRACEPARENT: traceparent }), { traceId: TRACE_ID, spanId: 'aaaaaaaaaaaaaaaa' })
  assert.deepEqual(
    resolveParent({ TRACEPARENT: traceparent, OTEL_STEP_NAME: 'Unit tests', OTEL_JOB_ID: '42', OTEL_TRACE_ID: TRACE_ID }),
    { traceId: TRACE_ID, spanId: stepSpanId(42, 'Unit tests') }
  )
  assert.equal(resolveParent({}), null)
})

test('reporter writes run > file > test spans under the parent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-vitest-'))
  const prev = { ...process.env }
  process.env.OTEL_VITEST_SPANS_DIR = dir
  process.env.TRACEPARENT = `00-${TRACE_ID}-aaaaaaaaaaaaaaaa-01`
  delete process.env.OTEL_STEP_NAME
  try {
    const module = {
      moduleId: '/repo/ui/tests/a.spec.ts',
      relativeModuleId: 'tests/a.spec.ts',
      project: { name: 'unit' },
      state: () => 'failed',
      children: {
        allTests: () => [
          {
            fullName: 'suite > passes',
            result: () => ({ state: 'passed' }),
            diagnostic: () => ({ startTime: 1000, duration: 5, retryCount: 0, flaky: false })
          },
          {
            fullName: 'suite > fails',
            result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }] }),
            diagnostic: () => ({ startTime: 1005, duration: 3, retryCount: 1, flaky: false })
          },
          { fullName: 'suite > todo', result: () => ({ state: 'pending' }), diagnostic: () => undefined }
        ]
      }
    }
    const reporter = new OtelVitestReporter()
    reporter.onTestRunStart()
    reporter.onTestModuleStart(module)
    reporter.onTestModuleEnd(module)
    reporter.onTestRunEnd([module], [], 'failed')

    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    const { traceId, spans } = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')) as VitestSpanFile
    assert.equal(traceId, TRACE_ID)
    assert.deepEqual(
      spans.map((s) => s.name),
      ['vitest unit', 'tests/a.spec.ts', 'tests/a.spec.ts > suite > passes', 'tests/a.spec.ts > suite > fails']
    )
    const [run, file, passed, failed] = spans
    assert.equal(run.parentSpanId, 'aaaaaaaaaaaaaaaa')
    assert.equal(run.conclusion, 'failure')
    assert.equal(file.parentSpanId, run.spanId)
    assert.equal(passed.parentSpanId, file.spanId)
    assert.equal(passed.conclusion, 'success')
    assert.equal(failed.startMs, 1005)
    assert.equal(failed.endMs, 1008)
    assert.equal(failed.conclusion, 'failure')
    assert.equal(failed.attributes['test.error'], 'expected 1 to be 2')
    assert.equal(failed.attributes['telemetry.source'], 'vitest')
  } finally {
    process.env = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reporter writes nothing without a parent trace context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-vitest-'))
  const prev = { ...process.env }
  process.env.OTEL_VITEST_SPANS_DIR = dir
  delete process.env.TRACEPARENT
  delete process.env.OTEL_STEP_NAME
  try {
    new OtelVitestReporter().onTestRunEnd([], [], 'passed')
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally {
    process.env = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('exportVitestSpans reads every span file and clears the directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-vitest-'))
  const span = { name: 't', spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', startMs: 1, endMs: 2, conclusion: null, attributes: {} }
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ traceId: TRACE_ID, spans: [span, span] }))
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ traceId: TRACE_ID, spans: [span] }))
  // Nothing listens on port 1: the export fails fast and is only logged.
  const count = await exportVitestSpans('svc', 1, 'wf', 'http://127.0.0.1:1', '', dir)
  assert.equal(count, 3)
  assert.equal(fs.existsSync(dir), false)
})
