import * as core from '@actions/core'
import * as github from '@actions/github'
import { buildWorkflowLogs } from './github-logs.js'
import { buildWorkflowTrace } from './github-trace.js'
import { traceId as makeTraceId } from '../../../shared/otel-core/src/ids.js'
import { exportLogs, exportSpans, parseHeaders } from '../../../shared/otel-core/src/otlp.js'
import { listJobs, type WorkflowJob } from '../../../shared/otel-core/src/resolve-job.js'

interface Inputs {
  githubToken: string
  otlpEndpoint: string
  otlpHeaders: string
  logsEnabled: boolean
  serviceName: string
}

function readInputs(): Inputs {
  return {
    githubToken: core.getInput('github-token', { required: true }),
    otlpEndpoint: core.getInput('otlp-endpoint', { required: true }),
    otlpHeaders: core.getInput('otlp-headers'),
    logsEnabled: core.getBooleanInput('logs-enabled'),
    serviceName: core.getInput('service-name')
  }
}

function serviceName(inputs: Inputs): string {
  return inputs.serviceName || `github-actions-${process.env.GITHUB_REPOSITORY ?? 'unknown'}`
}

const runId = (): number => github.context.runId
const runAttempt = (): number => Number(process.env.GITHUB_RUN_ATTEMPT ?? '1')

/** Reconstruct and export the whole workflow -> job -> step trace, once, for the whole run. */
async function exportAll(inputs: Inputs): Promise<void> {
  if (inputs.otlpHeaders) core.setSecret(inputs.otlpHeaders)

  const octokit = github.getOctokit(inputs.githubToken)
  const { owner, repo } = github.context.repo
  const jobs: WorkflowJob[] = await listJobs(octokit, owner, repo, runId(), runAttempt())

  const spans = buildWorkflowTrace(
    jobs,
    runId(),
    runAttempt(),
    process.env.GITHUB_WORKFLOW ?? '',
    serviceName(inputs),
    Date.now()
  )
  await exportSpans(spans, inputs.otlpEndpoint, parseHeaders(inputs.otlpHeaders))
  core.info(`Exported ${spans.length} span(s) for ${jobs.length} job(s)`)

  if (inputs.logsEnabled) {
    try {
      const logs = await buildWorkflowLogs(octokit, owner, repo, jobs, runId(), runAttempt(), serviceName(inputs))
      await exportLogs(logs, inputs.otlpEndpoint, parseHeaders(inputs.otlpHeaders), 30000)
      core.info(`Exported ${logs.length} log record(s) for ${jobs.length} job(s)`)
    } catch (err) {
      core.warning(`Failed to export logs: ${(err as Error).message}`)
    }
  }

  core.setOutput('trace-id', makeTraceId(runId(), runAttempt()))
}

async function run(): Promise<void> {
  try {
    await exportAll(readInputs())
  } catch (err) {
    // Never fail the job from telemetry; surface as a warning instead.
    core.warning(`otel-export-trace error: ${(err as Error).message}`)
  }
}

void run()
