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
  // own runner_name/runner flavour explicitly — this function runs inside the
  // export-all aggregation job, on a different (and possibly differently-flavoured)
  // runner than the one that ran `job`.
  const resource = buildResource(
    serviceName,
    job.id,
    job.runner_name ?? undefined,
    runnerEnvironmentOf(job),
    job.workflow_name ?? undefined
  )
  const spans: ReadableSpan[] = []
  // started_at is null for a job GitHub cancelled while still queued (e.g. via
  // `concurrency: cancel-in-progress`) — completed_at (the cancellation time) is
  // still set. Falling back started_at to nowMs (the export's own wall clock,
  // potentially long after that cancellation) would put jobStart after jobEnd,
  // producing a negative span duration. Fall back to jobEnd instead, so such a
  // job gets a 0-duration span rather than an inverted one.
  const jobEnd = parseTime(job.completed_at, nowMs)
  const jobStart = parseTime(job.started_at, jobEnd)
  const jSpanId = jobSpanId(job.id)

  // The job running this export (the export-all aggregation job itself) is still
  // `in_progress` — job.conclusion is null — at the moment it queries the
  // API, since it can't know its own outcome before it finishes. Fake it as
  // "success" rather than exporting an UNSET status next to an already-elapsed
  // end time, which reads as broken/stuck rather than as the exporter's own
  // unavoidable blind spot.
  const jobConclusion = job.conclusion ?? 'success'

  const jobInput: SpanInput = {
    name: job.name,
    traceId,
    spanId: jSpanId,
    parentSpanId,
    startMs: jobStart,
    endMs: jobEnd,
    conclusion: jobConclusion,
    attributes: {
      [TELEMETRY_SOURCE_ATTR]: 'github-actions',
      'github.job.name': job.name,
      'github.job.status': job.status,
      'github.job.conclusion': jobConclusion
    }
  }
  spans.push(buildSpan(jobInput, resource))

  for (const step of job.steps ?? []) {
    // Same fake-as-success reasoning as jobConclusion above: the step running this
    // very export is still in_progress and has no conclusion of its own yet.
    const stepConclusion = step.conclusion ?? 'success'
    const stepInput: SpanInput = {
      name: step.name,
      traceId,
      spanId: stepSpanId(job.id, step.name),
      parentSpanId: jSpanId,
      startMs: parseTime(step.started_at, jobStart),
      endMs: parseTime(step.completed_at, jobEnd),
      conclusion: stepConclusion,
      attributes: {
        [TELEMETRY_SOURCE_ATTR]: 'github-actions',
        'github.job.name': job.name,
        'github.step.name': step.name,
        'github.step.number': step.number,
        'github.step.status': step.status,
        'github.step.conclusion': stepConclusion
      }
    }
    spans.push(buildSpan(stepInput, resource))
  }

  return spans
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

  // Same started_at-null fallback as buildJobSpans above: fall back to each job's
  // own end, not nowMs, so a cancelled-while-queued job can't skew the root span's
  // start later than its end (min/max across jobs usually masks this, but not when
  // every job in the run is affected).
  const ends = ranJobs.map((j) => parseTime(j.completed_at, nowMs))
  const starts = ranJobs.map((j, i) => parseTime(j.started_at, ends[i]))
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
