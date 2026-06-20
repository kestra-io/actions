import type { Resource } from '@opentelemetry/resources'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { jobSpanId, rootSpanId, stepSpanId, traceId as makeTraceId } from './ids.js'
import { buildSpan, type SpanInput } from './otlp.js'
import type { WorkflowJob } from './resolve-job.js'

const parseTime = (iso: string | null | undefined, fallback: number): number => {
  if (!iso) return fallback
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? fallback : ms
}

/** Build the job span + one step span per step for a single job. */
export function buildJobSpans(
  job: WorkflowJob,
  traceId: string,
  parentSpanId: string,
  resource: Resource,
  nowMs: number
): ReadableSpan[] {
  const spans: ReadableSpan[] = []
  const jobStart = parseTime(job.started_at, nowMs)
  const jobEnd = parseTime(job.completed_at, nowMs)
  const jSpanId = jobSpanId(job.id)

  const jobInput: SpanInput = {
    name: job.name,
    traceId,
    spanId: jSpanId,
    parentSpanId,
    startMs: jobStart,
    endMs: jobEnd,
    conclusion: job.conclusion,
    attributes: {
      'cicd.pipeline.task.run.id': job.id,
      'github.job.name': job.name,
      'github.job.status': job.status,
      'github.job.conclusion': job.conclusion ?? ''
    }
  }
  spans.push(buildSpan(jobInput, resource))

  for (const step of job.steps ?? []) {
    const stepInput: SpanInput = {
      name: step.name,
      traceId,
      spanId: stepSpanId(job.id, step.name),
      parentSpanId: jSpanId,
      startMs: parseTime(step.started_at, jobStart),
      endMs: parseTime(step.completed_at, jobEnd),
      conclusion: step.conclusion,
      attributes: {
        'github.step.name': step.name,
        'github.step.number': step.number,
        'github.step.status': step.status,
        'github.step.conclusion': step.conclusion ?? ''
      }
    }
    spans.push(buildSpan(stepInput, resource))
  }

  return spans
}

/** Build only one job's spans (the per-job `post` hook). */
export function buildSingleJobTrace(
  job: WorkflowJob,
  runId: string | number,
  runAttempt: string | number,
  resource: Resource,
  nowMs: number
): ReadableSpan[] {
  const traceId = makeTraceId(runId, runAttempt)
  const rootId = rootSpanId(runId, runAttempt)
  return buildJobSpans(job, traceId, rootId, resource, nowMs)
}

/** Build the full workflow tree: root span + every job + every step (`export-all`). */
export function buildWorkflowTrace(
  jobs: WorkflowJob[],
  runId: string | number,
  runAttempt: string | number,
  workflowName: string,
  resource: Resource,
  nowMs: number
): ReadableSpan[] {
  const traceId = makeTraceId(runId, runAttempt)
  const rootId = rootSpanId(runId, runAttempt)

  const starts = jobs.map((j) => parseTime(j.started_at, nowMs))
  const ends = jobs.map((j) => parseTime(j.completed_at, nowMs))
  const rootStart = starts.length ? Math.min(...starts) : nowMs
  const rootEnd = ends.length ? Math.max(...ends) : nowMs

  const root = buildSpan(
    {
      name: workflowName || 'workflow',
      traceId,
      spanId: rootId,
      startMs: rootStart,
      endMs: rootEnd,
      conclusion: jobs.some((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped')
        ? 'failure'
        : 'success',
      attributes: {
        'github.workflow': workflowName,
        'github.run_id': String(runId),
        'github.run_attempt': String(runAttempt)
      }
    },
    resource
  )

  const spans: ReadableSpan[] = [root]
  for (const job of jobs) {
    spans.push(...buildJobSpans(job, traceId, rootId, resource, nowMs))
  }
  return spans
}
