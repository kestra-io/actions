import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { grpcTarget, parseHeaders, serviceInstanceId } from './otlp.js'

const RELEASES = 'https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download'

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

function buildConfig(endpoint: string, headers: Record<string, string>, serviceName: string): string {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join('\n')
  const { target, secure } = grpcTarget(endpoint)

  return `receivers:
  hostmetrics:
    collection_interval: 10s
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

processors:
  resourcedetection:
    # azure first: GitHub-hosted runners are Azure VMs, so it fills cloud.* metadata.
    # It probes the Azure IMDS endpoint and fails fast (non-fatal) on self-hosted/non-Azure.
    detectors: [env, azure, system]
    timeout: 5s
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
      - key: service.name
        value: ${JSON.stringify(serviceName)}
        action: upsert
      - key: service.instance.id
        value: ${JSON.stringify(serviceInstanceId())}
        action: upsert
      - key: github.run_id
        value: ${JSON.stringify(process.env.GITHUB_RUN_ID ?? '')}
        action: upsert
      - key: github.run_attempt
        value: ${JSON.stringify(process.env.GITHUB_RUN_ATTEMPT ?? '')}
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
      receivers: [hostmetrics]
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
  serviceName: string
): Promise<void> {
  const bin = await ensureCollector(version)
  const tmp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp'
  const configPath = path.join(tmp, 'otel-collect-config.yaml')
  const logPath = path.join(tmp, 'otel-collect-collector.log')

  fs.writeFileSync(configPath, buildConfig(endpoint, parseHeaders(rawHeaders), serviceName))

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
