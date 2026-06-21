import * as core from '@actions/core'
import type { GitHub } from '@actions/github/lib/utils.js'
import { SeverityNumber } from '@opentelemetry/api-logs'
import type { Resource } from '@opentelemetry/resources'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { jobSpanId, stepSpanId, traceId as makeTraceId } from './ids.js'
import { buildLogRecord, type LogInput } from './otlp.js'
import type { WorkflowJob } from './resolve-job.js'

type Octokit = InstanceType<typeof GitHub>

// Cap log lines emitted per job so a runaway log can't OOM the exporter.
const MAX_LINES_PER_JOB = 10000

// GitHub prefixes every log line with an ISO-8601 timestamp.
const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?(.*)$/

interface StepWindow {
  spanId: string
  start: number
  end: number
}

function severityOf(message: string): { number: SeverityNumber; text: string } {
  if (message.includes('##[error]')) return { number: SeverityNumber.ERROR, text: 'ERROR' }
  if (message.includes('##[warning]')) return { number: SeverityNumber.WARN, text: 'WARN' }
  return { number: SeverityNumber.INFO, text: 'INFO' }
}

/** Pick the step span whose time window contains the line, else fall back to the job span. */
function spanForTime(ms: number, steps: StepWindow[], jobSpan: string): string {
  for (const s of steps) {
    if (ms >= s.start && ms <= s.end) return s.spanId
  }
  return jobSpan
}

/** Parse a job's raw log text into log records correlated to its job/step spans. */
export function parseJobLog(
  text: string,
  job: WorkflowJob,
  traceId: string,
  resource: Resource
): ReadableLogRecord[] {
  const jobSpan = jobSpanId(job.id)
  const steps: StepWindow[] = (job.steps ?? [])
    .filter((s) => s.started_at && s.completed_at)
    .map((s) => ({
      spanId: stepSpanId(job.id, s.name),
      start: Date.parse(s.started_at as string),
      end: Date.parse(s.completed_at as string)
    }))

  const records: ReadableLogRecord[] = []
  let lastMs = job.started_at ? Date.parse(job.started_at) : Date.now()
  let truncated = false

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    if (records.length >= MAX_LINES_PER_JOB) {
      truncated = true
      break
    }

    const m = LINE_RE.exec(raw)
    const ts = m ? Date.parse(m[1]) : NaN
    const message = m ? m[2] : raw
    const timeMs = Number.isNaN(ts) ? lastMs : ts
    lastMs = timeMs
    if (!message.trim()) continue

    const sev = severityOf(message)
    const input: LogInput = {
      body: message,
      timeMs,
      severityNumber: sev.number,
      severityText: sev.text,
      traceId,
      spanId: spanForTime(timeMs, steps, jobSpan),
      attributes: {
        'github.job.name': job.name,
        'github.job.id': job.id
      }
    }
    records.push(buildLogRecord(input, resource))
  }

  if (truncated) {
    core.warning(`Job "${job.name}" log exceeded ${MAX_LINES_PER_JOB} lines; remaining lines were not exported`)
  }
  return records
}

/** Download a single job's logs as text (empty string if unavailable/expired). */
async function downloadJobLog(octokit: Octokit, owner: string, repo: string, jobId: number): Promise<string> {
  try {
    const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: jobId })
    return typeof res.data === 'string' ? res.data : String(res.data ?? '')
  } catch (err) {
    core.warning(`Could not download logs for job ${jobId}: ${(err as Error).message}`)
    return ''
  }
}

/** Fetch and parse logs for every job into correlated log records. */
export async function buildWorkflowLogs(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobs: WorkflowJob[],
  runId: string | number,
  runAttempt: string | number,
  resource: Resource
): Promise<ReadableLogRecord[]> {
  const traceId = makeTraceId(runId, runAttempt)
  const all: ReadableLogRecord[] = []
  for (const job of jobs) {
    // Logs are only downloadable once a job has finished; skip in-progress jobs
    // (notably the export job itself, still running while it calls this).
    if (job.status !== 'completed') continue
    const text = await downloadJobLog(octokit, owner, repo, job.id)
    if (!text) continue
    all.push(...parseJobLog(text, job, traceId, resource))
  }
  return all
}
