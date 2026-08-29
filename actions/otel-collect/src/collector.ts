import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { grpcTarget, parseHeaders, serviceInstanceId, NAMESPACE } from './otlp.js'

const RELEASES = 'https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download'

// Loopback-only OTLP/HTTP receiver the collector exposes for cgroup.ts's poller to push
// into, so container CPU/memory metrics get the same resourcedetection/resource/batch
// processing (and therefore the same github.*/host.name attributes) as hostmetrics.
// Non-default port to avoid colliding with a job's own app under test.
const CGROUP_METRICS_PORT = 14318
export const CGROUP_METRICS_ENDPOINT = `http://127.0.0.1:${CGROUP_METRICS_PORT}`

interface Asset {
  file: string
  isZip: boolean
}

function assetFor(version: string): Asset {
  const osMap: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' }
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }
  const os = osMap[process.platform] ?? 'linux'
  const arch = archMap[process.arch] ?? 'amd64'
  const isZip = process.platform === 'win32'
  const ext = isZip ? 'zip' : 'tar.gz'
  return { file: `otelcol-contrib_${version}_${os}_${arch}.${ext}`, isZip }
}

/** Download (and tool-cache) the otelcol-contrib binary, returning its path. */
async function ensureCollector(version: string): Promise<string> {
  const binName = process.platform === 'win32' ? 'otelcol-contrib.exe' : 'otelcol-contrib'

  let dir = tc.find('otelcol-contrib', version)
  if (!dir) {
    const asset = assetFor(version)
    const url = `${RELEASES}/v${version}/${asset.file}`
    core.info(`Downloading otelcol-contrib from ${url}`)
    const archive = await tc.downloadTool(url)
    const extracted = asset.isZip ? await tc.extractZip(archive) : await tc.extractTar(archive)
    dir = await tc.cacheDir(extracted, 'otelcol-contrib', version)
  }
  return path.join(dir, binName)
}

function buildConfig(
  endpoint: string,
  headers: Record<string, string>,
  serviceName: string,
  jobId?: number,
  workflowName?: string,
  jobFullName?: string
): string {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join('\n')
  const { target, secure } = grpcTarget(endpoint)

  return `receivers:
  hostmetrics:
    # 1s was chosen so short-lived jobs (a few seconds) couldn't finish and get
    # SIGTERM'd before a scrape ever fired. That is already handled by
    # initial_delay (default 1s), which is independent of collection_interval —
    # the first scrape lands ~1s in whatever this is set to — so the interval
    # only trades document volume against resolution. 1s cost ~843k documents
    # for a single 32-minute 16-core job (128 cpu data points *per second*,
    # before the other scrapers); 2s halves that and is still finer than any
    # CI dashboard needs.
    collection_interval: 2s
    scrapers:
      cpu:
        metrics:
          # Optional metrics Elastic's Hosts UI needs; off by default.
          system.cpu.utilization:
            enabled: true
          system.cpu.logical.count:
            enabled: true
      memory:
        metrics:
          system.memory.utilization:
            enabled: true
      load:
      disk:
      filesystem:
      network:
      paging:
  otlp:
    # Receives container.cpu.*/container.memory.*/container.io.* pushed by cgroup.ts's poller
    # process — hostmetrics above can't see the pod's cgroup, only the node's.
    protocols:
      http:
        endpoint: 127.0.0.1:${CGROUP_METRICS_PORT}

processors:
  resourcedetection:
    # Cover both runner flavours: gcp (self-hosted GCP) and azure (GitHub-hosted).
    # Each probes its cloud metadata endpoint and fails fast (non-fatal) when it
    # isn't that cloud; system fills the rest. The non-matching detector is harmless.
    detectors: [env, gcp, azure, system]
    timeout: 5s
    gcp:
      resource_attributes:
        cloud.provider:
          enabled: true
        cloud.region:
          enabled: true
        cloud.availability_zone:
          enabled: true
        host.id:
          enabled: true
        host.name:
          enabled: true
        host.type:
          enabled: true
    azure:
      resource_attributes:
        cloud.provider:
          enabled: true
        cloud.region:
          enabled: true
        host.name:
          enabled: true
    system:
      resource_attributes:
        host.id:
          enabled: true
        host.ip:
          enabled: true
        os.description:
          enabled: true
  resource:
    attributes:
      # GitHub-hosted runners can report a non-unique OS-level hostname (Azure IMDS
      # instance name isn't guaranteed unique per ephemeral job VM), which collapses
      # concurrent jobs' host metrics onto the same host.name. RUNNER_NAME is set by
      # GitHub Actions itself and is unique per job on both hosted and self-hosted
      # runners, so it always wins over whatever resourcedetection found.
      - key: host.name
        value: \${env:RUNNER_NAME}
        action: upsert
      - key: service.name
        value: ${JSON.stringify(serviceName)}
        action: upsert
      - key: service.namespace
        value: ${JSON.stringify(NAMESPACE)}
        action: upsert
      - key: data_stream.namespace
        value: ${JSON.stringify(NAMESPACE)}
        action: upsert
      - key: service.instance.id
        value: ${JSON.stringify(serviceInstanceId(jobId))}
        action: upsert
      - key: vcs.repository.name
        value: ${JSON.stringify(process.env.GITHUB_REPOSITORY ?? '')}
        action: upsert
      - key: github.workflow.name
        # GITHUB_WORKFLOW always resolves to the top-level *caller* workflow's name
        # for a job called via \`workflow_call\`, so this is passed in resolved from
        # the GitHub Jobs API's per-job \`workflow_name\` (see resolve-job.ts) instead.
        value: ${JSON.stringify(workflowName ?? process.env.GITHUB_WORKFLOW ?? '')}
        action: upsert
      - key: github.run_id
        value: ${JSON.stringify(process.env.GITHUB_RUN_ID ?? '')}
        action: upsert
      - key: github.run_attempt
        value: ${JSON.stringify(process.env.GITHUB_RUN_ATTEMPT ?? '')}
        action: upsert
      - key: github.job_id
        value: ${JSON.stringify(jobId !== undefined ? String(jobId) : '')}
        action: upsert
      - key: github.sha
        value: ${JSON.stringify(process.env.GITHUB_SHA ?? '')}
        action: upsert
      - key: github.ref
        value: ${JSON.stringify(process.env.GITHUB_REF ?? '')}
        action: upsert
      - key: github.job.name
        # Matrix-resolved display name from the Jobs API (e.g. "build (18.x)"), matching
        # the github.job.name attribute traces/logs export — falls back to GITHUB_JOB
        # (which never carries matrix context) only if that lookup failed.
        value: ${JSON.stringify(jobFullName ?? process.env.GITHUB_JOB ?? '')}
        action: upsert
      - key: github.job.key
        # The workflow YAML's short job key (e.g. "build"), distinct from the
        # matrix-resolved github.job.name above.
        value: ${JSON.stringify(process.env.GITHUB_JOB ?? '')}
        action: upsert
      - key: github.runner_environment
        value: \${env:RUNNER_ENVIRONMENT}
        action: upsert
  batch:

exporters:
  otlp:
    endpoint: ${JSON.stringify(target)}
    tls:
      insecure: ${secure ? 'false' : 'true'}
${headerLines ? `    headers:\n${headerLines}` : ''}

service:
  pipelines:
    metrics:
      receivers: [hostmetrics, otlp]
      processors: [resourcedetection, resource, batch]
      exporters: [otlp]
`
}

const PID_STATE = 'otel-collector-pid'

/** Start the collector daemon in the background. Stores its pid in action state. */
export async function startCollector(
  version: string,
  endpoint: string,
  rawHeaders: string,
  serviceName: string,
  jobId?: number,
  workflowName?: string,
  jobFullName?: string
): Promise<void> {
  const bin = await ensureCollector(version)
  const tmp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp'
  const configPath = path.join(tmp, 'otel-collect-config.yaml')
  const logPath = path.join(tmp, 'otel-collect-collector.log')

  fs.writeFileSync(
    configPath,
    buildConfig(endpoint, parseHeaders(rawHeaders), serviceName, jobId, workflowName, jobFullName)
  )

  const out = fs.openSync(logPath, 'a')
  const child = spawn(bin, ['--config', configPath], {
    detached: true,
    stdio: ['ignore', out, out]
  })
  child.unref()

  if (child.pid) {
    core.saveState(PID_STATE, String(child.pid))
    core.info(`Started host-metrics collector (pid ${child.pid}), logging to ${logPath}`)
  } else {
    core.warning('Failed to start host-metrics collector')
  }
}

/** Stop the collector daemon, giving it a moment to flush. */
export async function stopCollector(): Promise<void> {
  const pidRaw = core.getState(PID_STATE)
  if (!pidRaw) return
  const pid = Number(pidRaw)
  if (!Number.isInteger(pid)) return

  try {
    process.kill(pid, 'SIGTERM')
    core.info(`Sent SIGTERM to collector (pid ${pid}); waiting for flush`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  } catch (err) {
    core.debug(`Collector already stopped: ${(err as Error).message}`)
  }
}
