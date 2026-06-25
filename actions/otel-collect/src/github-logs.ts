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

// ANSI escape sequences GitHub embeds for colored output (e.g. "\x1b[36;1m"), which
// render as garbage like "[36;1m" in a log backend. Matches CSI sequences (\x1b[ …
// final byte) and OSC sequences (\x1b] … BEL/ST) so we can strip them out.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Remove ANSI escape sequences so log bodies are plain, readable text. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

// GitHub Actions "workflow command" markers embedded in downloaded logs — ##[group],
// ##[endgroup], ##[error], ##[warning], ##[command], ##[section], ##[debug], … They
// drive the GitHub UI's log folding/coloring and are just noise in a log backend, so
// strip the marker token (keeping any trailing text). Severity is read off the marker
// before this runs, so dropping it here doesn't lose the error/warning level.
const GH_COMMAND_RE = /##\[[^\]]*\]/g

/** Remove GitHub workflow-command markers, leaving the human-readable text. */
function stripGhCommands(text: string): string {
  return text.replace(GH_COMMAND_RE, '')
}

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

  // Coalesce continuation lines (stack traces, wrapped output) into the logical
  // entry they belong to. GitHub timestamps every physical line, so a "new entry"
  // is one with a timestamp AND no leading indentation; anything else (indented or
  // untimestamped) is appended to the previous entry's body.
  const entries: { timeMs: number; message: string; severity: ReturnType<typeof severityOf> }[] = []
  let lastMs = job.started_at ? Date.parse(job.started_at) : Date.now()
  let truncated = false

  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') continue
    if (entries.length >= MAX_LINES_PER_JOB) {
      truncated = true
      break
    }

    const m = LINE_RE.exec(raw)
    const hasTs = m !== null && !Number.isNaN(Date.parse(m[1]))
    // ANSI-clean text still carrying any ##[…] marker, used for severity + indentation.
    const clean = stripAnsi(m ? m[2] : raw)

    const isContinuation = entries.length > 0 && (!hasTs || /^\s/.test(clean))
    if (isContinuation) {
      entries[entries.length - 1].message += `\n${stripGhCommands(clean)}`
      continue
    }

    // Read severity off the marker, then drop the marker from the body.
    const severity = severityOf(clean)
    const message = stripGhCommands(clean)
    if (!message.trim()) continue
    const timeMs = hasTs ? Date.parse((m as RegExpExecArray)[1]) : lastMs
    lastMs = timeMs
    entries.push({ timeMs, message, severity })
  }

  const records: ReadableLogRecord[] = entries.map((entry) => {
    const input: LogInput = {
      body: entry.message,
      timeMs: entry.timeMs,
      severityNumber: entry.severity.number,
      severityText: entry.severity.text,
      traceId,
      spanId: spanForTime(entry.timeMs, steps, jobSpan),
      attributes: {
        'github.job.name': job.name,
        'github.job.id': job.id
      }
    }
    return buildLogRecord(input, resource)
  })

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
