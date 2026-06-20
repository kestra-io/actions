import * as core from '@actions/core'
import * as github from '@actions/github'
import { setupJavaAgent, setupNodeAgent } from './agents.js'
import { startCollector, stopCollector } from './collector.js'
import { buildSingleJobTrace, buildWorkflowTrace } from './github-trace.js'
import { jobSpanId, stepSpanId, traceId as makeTraceId } from './ids.js'
import { buildResource, exportSpans, parseHeaders } from './otlp.js'
import { listJobs, resolveJobId, type WorkflowJob } from './resolve-job.js'

const STARTED_STATE = 'otel-collect-started'
const JOB_ID_STATE = 'otel-collect-job-id'

interface Inputs {
  githubToken: string
  otlpEndpoint: string
  otlpHeaders: string
  mode: string
  javaEnabled: boolean
  nodeEnabled: boolean
  injectJavaAgent: boolean
  injectNodeAgent: boolean
  hostMetricsEnabled: boolean
  parentStepName: string
  collectorVersion: string
  javaAgentVersion: string
  serviceName: string
}

function readInputs(): Inputs {
  return {
    githubToken: core.getInput('github-token', { required: true }),
    otlpEndpoint: core.getInput('otlp-endpoint', { required: true }),
    otlpHeaders: core.getInput('otlp-headers'),
    mode: core.getInput('mode') || 'instrument',
    javaEnabled: core.getBooleanInput('java-enabled'),
    nodeEnabled: core.getBooleanInput('node-enabled'),
    injectJavaAgent: core.getBooleanInput('inject-java-agent'),
    injectNodeAgent: core.getBooleanInput('inject-node-agent'),
    hostMetricsEnabled: core.getBooleanInput('host-metrics-enabled'),
    parentStepName: core.getInput('parent-step-name'),
    collectorVersion: core.getInput('collector-version'),
    javaAgentVersion: core.getInput('java-agent-version'),
    serviceName: core.getInput('service-name')
  }
}

function serviceName(inputs: Inputs): string {
  return inputs.serviceName || `github-actions-${process.env.GITHUB_REPOSITORY ?? 'unknown'}`
}

const runId = (): number => github.context.runId
const runAttempt = (): number => Number(process.env.GITHUB_RUN_ATTEMPT ?? '1')

/** Per-job setup: root context, agents, host metrics. */
async function main(inputs: Inputs): Promise<void> {
  if (inputs.otlpHeaders) core.setSecret(inputs.otlpHeaders)

  const octokit = github.getOctokit(inputs.githubToken)
  const { owner, repo } = github.context.repo

  const jobId = await resolveJobId(octokit, owner, repo, runId(), runAttempt())
  if (jobId === null) {
    core.warning('Could not resolve the current job id; build spans may not nest correctly')
  } else {
    core.saveState(JOB_ID_STATE, String(jobId))
  }

  const tId = makeTraceId(runId(), runAttempt())
  let parentSpanId: string | null = null
  if (jobId !== null) {
    parentSpanId = inputs.parentStepName ? stepSpanId(jobId, inputs.parentStepName) : jobSpanId(jobId)
  }

  // Propagate trace context + OTLP config so child processes auto-instrument under our tree.
  if (parentSpanId) {
    const traceparent = `00-${tId}-${parentSpanId}-01`
    core.exportVariable('TRACEPARENT', traceparent)
    core.setOutput('traceparent', traceparent)
  }
  core.exportVariable('OTEL_EXPORTER_OTLP_ENDPOINT', inputs.otlpEndpoint)
  if (inputs.otlpHeaders) core.exportVariable('OTEL_EXPORTER_OTLP_HEADERS', inputs.otlpHeaders)
  // Match the gRPC transport the post-hoc exporter and collector use, so an injected
  // agent talks to the same (gRPC) endpoint instead of defaulting to http/protobuf.
  core.exportVariable('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc')
  core.exportVariable('OTEL_PROPAGATORS', 'tracecontext,baggage')
  core.exportVariable('OTEL_TRACES_SAMPLER', 'parentbased_always_on')
  core.exportVariable('OTEL_SERVICE_NAME', serviceName(inputs))
  core.setOutput('trace-id', tId)

  if (inputs.javaEnabled) {
    const jar = await setupJavaAgent(inputs.javaAgentVersion, inputs.injectJavaAgent)
    core.setOutput('java-agent-path', jar)
  }
  if (inputs.nodeEnabled) {
    const register = await setupNodeAgent(inputs.injectNodeAgent)
    core.setOutput('node-agent-path', register)
  }

  if (inputs.hostMetricsEnabled) {
    await startCollector(inputs.collectorVersion, inputs.otlpEndpoint, inputs.otlpHeaders, serviceName(inputs))
  }

  core.saveState(STARTED_STATE, 'true')
}

/** Per-job post: stop the collector and export this job's step spans. */
async function post(inputs: Inputs): Promise<void> {
  await stopCollector()

  const jobIdRaw = core.getState(JOB_ID_STATE)
  if (!jobIdRaw) {
    core.info('No resolved job id in state; skipping step-span export')
    return
  }
  const jobId = Number(jobIdRaw)

  try {
    const octokit = github.getOctokit(inputs.githubToken)
    const { owner, repo } = github.context.repo
    const jobs = await listJobs(octokit, owner, repo, runId(), runAttempt())
    const job = jobs.find((j) => j.id === jobId)
    if (!job) {
      core.warning(`Job ${jobId} not found in API response; skipping export`)
      return
    }

    const resource = buildResource(serviceName(inputs))
    const spans = buildSingleJobTrace(job, runId(), runAttempt(), resource, Date.now())
    await exportSpans(spans, inputs.otlpEndpoint, parseHeaders(inputs.otlpHeaders))
    core.info(`Exported ${spans.length} span(s) for job "${job.name}"`)
  } catch (err) {
    core.warning(`Failed to export step spans: ${(err as Error).message}`)
  }
}

/** Final aggregation job: export the whole workflow tree. */
async function exportAll(inputs: Inputs): Promise<void> {
  const octokit = github.getOctokit(inputs.githubToken)
  const { owner, repo } = github.context.repo
  const jobs: WorkflowJob[] = await listJobs(octokit, owner, repo, runId(), runAttempt())

  const resource = buildResource(serviceName(inputs))
  const spans = buildWorkflowTrace(
    jobs,
    runId(),
    runAttempt(),
    process.env.GITHUB_WORKFLOW ?? '',
    resource,
    Date.now()
  )
  await exportSpans(spans, inputs.otlpEndpoint, parseHeaders(inputs.otlpHeaders))
  core.info(`Exported ${spans.length} span(s) for ${jobs.length} job(s)`)
  core.setOutput('trace-id', makeTraceId(runId(), runAttempt()))
}

async function run(): Promise<void> {
  try {
    const inputs = readInputs()
    if (inputs.mode === 'export-all') {
      await exportAll(inputs)
    } else if (core.getState(STARTED_STATE) === 'true') {
      await post(inputs)
    } else {
      await main(inputs)
    }
  } catch (err) {
    // Never fail the job from telemetry; surface as a warning instead.
    core.warning(`otel-collect error: ${(err as Error).message}`)
  }
}

void run()
