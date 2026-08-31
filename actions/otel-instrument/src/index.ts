import * as os from 'os'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { setupJavaAgent, setupNodeAgent } from './agents.js'
import {
  CGROUP_POLLER_ENDPOINT_ENV,
  CGROUP_POLLER_ENV,
  runCgroupPollerProcess,
  startCgroupPoller,
  stopCgroupPoller
} from './cgroup.js'
import { CGROUP_METRICS_ENDPOINT, startCollector, stopCollector } from './collector.js'
import { installGradleInitScript } from './gradle.js'
import { jobSpanId, stepSpanId, traceId as makeTraceId } from '../../../shared/otel-core/src/ids.js'
import { baseEndpoint, NAMESPACE } from '../../../shared/otel-core/src/otlp.js'
import { resolveJob } from '../../../shared/otel-core/src/resolve-job.js'

const STARTED_STATE = 'otel-instrument-started'

interface Inputs {
  githubToken: string
  otlpEndpoint: string
  otlpHeaders: string
  javaEnabled: boolean
  nodeEnabled: boolean
  injectJavaAgent: boolean
  injectNodeAgent: boolean
  hostMetricsEnabled: boolean
  cgroupMetricsEnabled: boolean
  gradleTracingEnabled: boolean
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
    javaEnabled: core.getBooleanInput('java-enabled'),
    nodeEnabled: core.getBooleanInput('node-enabled'),
    injectJavaAgent: core.getBooleanInput('inject-java-agent'),
    injectNodeAgent: core.getBooleanInput('inject-node-agent'),
    hostMetricsEnabled: core.getBooleanInput('host-metrics-enabled'),
    cgroupMetricsEnabled: core.getBooleanInput('cgroup-metrics-enabled'),
    gradleTracingEnabled: core.getBooleanInput('gradle-tracing-enabled'),
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

  const job = await resolveJob(octokit, owner, repo, runId(), runAttempt())
  const jobId = job?.id ?? null
  if (jobId === null) {
    core.warning('Could not resolve the current job id; build spans may not nest correctly')
  }
  // GITHUB_WORKFLOW always resolves to the top-level *caller* workflow's name for a
  // job called via `workflow_call`; job.workflow_name (GitHub Jobs API) is the
  // actually-running (reusable) workflow's own name, e.g. "Frontend tests" instead
  // of "Main Workflow" — falls back to GITHUB_WORKFLOW when the job lookup above failed.
  const workflowName = job?.workflow_name ?? process.env.GITHUB_WORKFLOW ?? ''

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
  // gRPC requires a base endpoint with no signal path ("/v1/traces" is rejected),
  // so normalize whatever endpoint was provided before handing it to child agents.
  core.exportVariable('OTEL_EXPORTER_OTLP_ENDPOINT', baseEndpoint(inputs.otlpEndpoint))
  if (inputs.otlpHeaders) core.exportVariable('OTEL_EXPORTER_OTLP_HEADERS', inputs.otlpHeaders)
  // Match the gRPC transport the post-hoc exporter and collector use, so an injected
  // agent talks to the same (gRPC) endpoint instead of defaulting to http/protobuf.
  core.exportVariable('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc')
  core.exportVariable('OTEL_PROPAGATORS', 'tracecontext,baggage')
  core.exportVariable('OTEL_TRACES_SAMPLER', 'parentbased_always_on')
  core.exportVariable('OTEL_SERVICE_NAME', serviceName(inputs))
  // Group injected-agent (Java/Node) telemetry under the same namespace as the
  // spans/metrics/logs this action emits directly. data_stream.namespace is what
  // Elastic uses to route OTLP into a data stream (else it falls back to "default").
  // host.name matches buildResource() and the hostmetrics collector, so APM can link
  // these agents' services to this runner's infrastructure metrics too.
  core.exportVariable(
    'OTEL_RESOURCE_ATTRIBUTES',
    `service.namespace=${NAMESPACE},data_stream.namespace=${NAMESPACE},host.name=${process.env.RUNNER_NAME ?? os.hostname()}`
  )
  core.setOutput('trace-id', tId)

  if (inputs.javaEnabled) {
    const jar = await setupJavaAgent(inputs.javaAgentVersion, inputs.injectJavaAgent)
    core.setOutput('java-agent-path', jar)
  }
  if (inputs.nodeEnabled) {
    const register = await setupNodeAgent(inputs.injectNodeAgent)
    core.setOutput('node-agent-path', register)
  }

  if (inputs.gradleTracingEnabled) {
    installGradleInitScript(serviceName(inputs), jobId, workflowName)
  }

  if (inputs.hostMetricsEnabled) {
    await startCollector(
      inputs.collectorVersion,
      inputs.otlpEndpoint,
      inputs.otlpHeaders,
      serviceName(inputs),
      jobId ?? undefined,
      workflowName,
      job?.name
    )

    // Needs the collector above running: it pushes into its local OTLP receiver
    // rather than exporting directly (see cgroup.ts), so its container.cpu.*/
    // container.memory.* metrics pick up the same resource attributes.
    if (inputs.cgroupMetricsEnabled) {
      await startCgroupPoller(CGROUP_METRICS_ENDPOINT)
    }
  }
}

/**
 * Per-job post: stop the cgroup poller and the collector so their metrics are flushed.
 *
 * It deliberately exports no spans. Job and step span ids are deterministic
 * (jobSpanId/stepSpanId), so a job exporting its own tree here and the final
 * `otel-export-trace` job re-exporting it would emit the *same* span twice — and a
 * traces data stream appends rather than upserts on trace_id+span_id. The copy
 * written from inside the job is also the wrong one: the Jobs API still reports
 * that job as `in_progress` with no conclusion, so it lands with a faked
 * "success" and a Date.now() end time. `otel-export-trace` is the single source of
 * truth for the GitHub Actions span layer.
 */
async function post(): Promise<void> {
  await stopCgroupPoller()
  await stopCollector()
}

async function run(): Promise<void> {
  try {
    // startCgroupPoller() re-invokes this same entrypoint (process.argv[1]) with
    // this flag set, so this detached process loops sampling cgroup stats instead
    // of running the action — never reaches readInputs()/core.getState() below,
    // which expect the normal main/post action environment.
    if (process.env[CGROUP_POLLER_ENV] === '1') {
      runCgroupPollerProcess(process.env[CGROUP_POLLER_ENDPOINT_ENV] ?? CGROUP_METRICS_ENDPOINT)
      return
    }

    const inputs = readInputs()
    // The action's main and post hooks share this entrypoint. STARTED_STATE is set
    // on the first (main) invocation, so a 'true' value here means we're in post.
    const isPost = core.getState(STARTED_STATE) === 'true'
    core.saveState(STARTED_STATE, 'true')

    if (isPost) {
      await post()
    } else {
      await main(inputs)
    }
  } catch (err) {
    // Never fail the job from telemetry; surface as a warning instead.
    core.warning(`otel-instrument error: ${(err as Error).message}`)
  }
}

void run()
