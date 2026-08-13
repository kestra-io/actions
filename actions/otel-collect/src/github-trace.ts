import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { jobSpanId, rootSpanId, stepSpanId, traceId as makeTraceId } from './ids.js'
import { buildResource, buildSpan, TELEMETRY_SOURCE_ATTR, type SpanInput } from './otlp.js'
import { runnerEnvironmentOf, type WorkflowJob } from './resolve-job.js'

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
  serviceName: string,
  nowMs: number
): ReadableSpan[] {
  // Scoped to this job's id, not just the run: a workflow run has many jobs, each
  // on its own runner, so a run-level instance id would collapse all their host
  // metrics under one "instance" (see otlp.ts serviceInstanceId). Pass this job's
  // own runner_name/runner flavour explicitly — this function may run inside the
  // export-all aggregation job, on a different (and possibly differently-flavoured)
  // runner than the one that ran `job`.
  const resource = buildResource(serviceName, job.id, job.runner_name ?? undefined, runnerEnvironmentOf(job))
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
      [TELEMETRY_SOURCE_ATTR]: 'github-actions',
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
        [TELEMETRY_SOURCE_ATTR]: 'github-actions',
        'github.job.name': job.name,
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
  serviceName: string,
  nowMs: number
): ReadableSpan[] {
  const traceId = makeTraceId(runId, runAttempt)
  const rootId = rootSpanId(runId, runAttempt)
  return buildJobSpans(job, traceId, rootId, serviceName, nowMs)
}

/** Build the full workflow tree: root span + every job + every step (`export-all`). */
export function buildWorkflowTrace(
  jobs: WorkflowJob[],
  runId: string | number,
  runAttempt: string | number,
  workflowName: string,
  serviceName: string,
  nowMs: number
): ReadableSpan[] {
  const traceId = makeTraceId(runId, runAttempt)
  const rootId = rootSpanId(runId, runAttempt)

  const ranJobs = jobs.filter((j) => j.conclusion !== 'skipped')

  const starts = ranJobs.map((j) => parseTime(j.started_at, nowMs))
  const ends = ranJobs.map((j) => parseTime(j.completed_at, nowMs))
  const rootStart = starts.length ? Math.min(...starts) : nowMs
  const rootEnd = ends.length ? Math.max(...ends) : nowMs

  // No single job id: this span represents the whole run, not one runner, so it
  // gets the run-level instance id (buildResource with no jobId).
  const root = buildSpan(
    {
      name: workflowName || 'workflow',
      traceId,
      spanId: rootId,
      startMs: rootStart,
      endMs: rootEnd,
      conclusion: ranJobs.some((j) => j.conclusion && j.conclusion !== 'success') ? 'failure' : 'success',
      attributes: {
        [TELEMETRY_SOURCE_ATTR]: 'github-actions',
        'github.run_id': String(runId),
        'github.run_attempt': String(runAttempt)
      }
    },
    buildResource(serviceName)
  )

  const spans: ReadableSpan[] = [root]
  for (const job of ranJobs) {
    spans.push(...buildJobSpans(job, traceId, rootId, serviceName, nowMs))
  }
  return spans
}
