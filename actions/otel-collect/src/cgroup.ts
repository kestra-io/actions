import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'

/**
 * `hostmetrics` (collector.ts) reads /proc/stat, which is not cgroup-aware: on a
 * Kubernetes runner it reports the whole node's CPUs, not the pod's CPU limit —
 * a 4-CPU-limited pod shows up with the node's full CPU count. This module reads
 * the pod's own cgroup instead, so CPU usage can be expressed against the limit
 * actually enforced on this job, and throttling (nr_throttled) — which no
 * node-wide reading can show at all — becomes visible.
 *
 * otelcol-contrib has no cgroup receiver and `hostmetrics` has no cgroup scraper
 * (its `root_path` option does the opposite: it makes a containerized collector
 * report the host). `kubeletstats` does expose k8s.pod.cpu_limit_utilization
 * natively, but only with nodes/stats + nodes/pods RBAC and a downward-API node
 * name configured on the runner pod — cluster-side config this action can't ship,
 * and nothing at all on non-Kubernetes runners. Hence reading cgroup v2 directly.
 *
 * Runs as a second detached process (mirroring collector.ts's daemon) because a
 * time series needs sampling on an interval. It POSTs OTLP/HTTP JSON straight
 * into the hostmetrics collector's own OTLP receiver (CGROUP_METRICS_ENDPOINT in
 * collector.ts) rather than exporting directly, so the collector's existing
 * `resource` processor stamps every github.* / host.name / service.instance.id
 * attribute for us — these land pre-joined to the hostmetrics ones.
 *
 * Everything here is cgroup v2 only (the runners are Ubuntu 24.04, which is
 * v2-exclusive). Hosts without it are logged and skipped rather than silently
 * producing nothing.
 */

const CGROUP_ROOT = '/sys/fs/cgroup'

export interface CgroupSnapshot {
  /** Monotonic sample time (process.hrtime.bigint()), never wall clock. */
  timeNanos: bigint
  /** Cumulative CPU time consumed since the cgroup was created, in microseconds. */
  cpuUsageUsec: number
  /** CPU limit in cores, or null when unlimited/unknown. */
  cpuLimitCores: number | null
  nrPeriods: number | null
  nrThrottled: number | null
  /** Cumulative time spent throttled, in microseconds. */
  throttledUsec: number | null
  memoryUsageBytes: number | null
  /** Memory limit in bytes, or null when unlimited/unknown. */
  memoryLimitBytes: number | null
}

/** Parse `cpu.max` ("<quota> <period>" in microseconds, or "max <period>" when unlimited) into a core-count limit. */
export function parseCpuMax(content: string): number | null {
  const [quotaRaw, periodRaw] = content.trim().split(/\s+/)
  if (!quotaRaw || quotaRaw === 'max' || !periodRaw) return null
  const quota = Number(quotaRaw)
  const period = Number(periodRaw)
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null
  return quota / period
}

/** Parse a cgroup "key value\n..." stat file (cpu.stat) into a map. */
export function parseKeyValueStat(content: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of content.trim().split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (key === undefined || value === undefined) continue
    const n = Number(value)
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

/** Parse a byte-count file (`memory.current`/`memory.max`, "max" = unlimited). */
export function parseMemoryValue(content: string): number | null {
  const trimmed = content.trim()
  if (trimmed === 'max') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function tryRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read this process's cgroup v2 CPU/memory stats. Returns null when there is no
 * cgroup v2 filesystem — macOS, Windows, and non-containerized runners — so
 * callers can skip instead of exporting a permanently-empty metric.
 */
export function readCgroupSnapshot(nowNanos: bigint = process.hrtime.bigint()): CgroupSnapshot | null {
  const cpuStat = tryRead(`${CGROUP_ROOT}/cpu.stat`)
  if (cpuStat === null) return null

  const stat = parseKeyValueStat(cpuStat)
  const cpuMax = tryRead(`${CGROUP_ROOT}/cpu.max`)
  const memCurrent = tryRead(`${CGROUP_ROOT}/memory.current`)
  const memMax = tryRead(`${CGROUP_ROOT}/memory.max`)

  return {
    timeNanos: nowNanos,
    cpuUsageUsec: stat.usage_usec ?? 0,
    cpuLimitCores: cpuMax !== null ? parseCpuMax(cpuMax) : null,
    nrPeriods: stat.nr_periods ?? null,
    nrThrottled: stat.nr_throttled ?? null,
    throttledUsec: stat.throttled_usec ?? null,
    memoryUsageBytes: memCurrent !== null ? parseMemoryValue(memCurrent) : null,
    memoryLimitBytes: memMax !== null ? parseMemoryValue(memMax) : null
  }
}

interface OtlpMetric {
  name: string
  unit: string
  gauge?: { dataPoints: Array<{ timeUnixNano: string; asDouble: number }> }
  sum?: {
    aggregationTemporality: number
    isMonotonic: boolean
    dataPoints: Array<{ startTimeUnixNano: string; timeUnixNano: string; asDouble: number }>
  }
}

export interface OtlpMetricsPayload {
  resourceMetrics: Array<{
    resource: { attributes: unknown[] }
    scopeMetrics: Array<{ scope: { name: string; version: string }; metrics: OtlpMetric[] }>
  }>
}

const SCOPE = { name: 'kestra-io/actions/otel-collect/cgroup', version: '1.0.0' }
// OTLP proto AggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE.
const CUMULATIVE = 2

function gauge(name: string, unit: string, value: number, timeUnixNano: string): OtlpMetric {
  return { name, unit, gauge: { dataPoints: [{ timeUnixNano, asDouble: value }] } }
}

function cumulativeSum(name: string, unit: string, value: number, startTimeUnixNano: string, timeUnixNano: string): OtlpMetric {
  return {
    name,
    unit,
    sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints: [{ startTimeUnixNano, timeUnixNano, asDouble: value }] }
  }
}

/**
 * Build an OTLP/HTTP JSON metrics payload from a cgroup snapshot. The CPU and
 * throttling counters are raw cumulative kernel totals, emitted with CUMULATIVE
 * temporality against a fixed start time — no rate is computed here on purpose:
 * cores-used is `rate(container.cpu.time)` and utilization is
 * `rate(container.cpu.time) / container.cpu.limit` in the query layer, which
 * already does this better than re-deriving it per sample would.
 */
export function buildMetricsPayload(curr: CgroupSnapshot, startTimeNanos: bigint): OtlpMetricsPayload {
  const startTimeUnixNano = startTimeNanos.toString()
  const timeUnixNano = curr.timeNanos.toString()
  const metrics: OtlpMetric[] = [cumulativeSum('container.cpu.time', 's', curr.cpuUsageUsec / 1e6, startTimeUnixNano, timeUnixNano)]

  if (curr.nrPeriods !== null) metrics.push(cumulativeSum('container.cpu.periods', '{period}', curr.nrPeriods, startTimeUnixNano, timeUnixNano))
  if (curr.nrThrottled !== null) {
    metrics.push(cumulativeSum('container.cpu.throttled.periods', '{period}', curr.nrThrottled, startTimeUnixNano, timeUnixNano))
  }
  if (curr.throttledUsec !== null) {
    metrics.push(cumulativeSum('container.cpu.throttled.time', 's', curr.throttledUsec / 1e6, startTimeUnixNano, timeUnixNano))
  }
  // Limits are emitted as numeric gauges rather than resource attributes: Elastic
  // indexes resource attributes as keywords, which would force TO_DOUBLE() before
  // any arithmetic and add a dimension to every hostmetrics series too.
  if (curr.cpuLimitCores !== null) metrics.push(gauge('container.cpu.limit', '{cpu}', curr.cpuLimitCores, timeUnixNano))
  if (curr.memoryUsageBytes !== null) metrics.push(gauge('container.memory.usage', 'By', curr.memoryUsageBytes, timeUnixNano))
  if (curr.memoryLimitBytes !== null) metrics.push(gauge('container.memory.limit', 'By', curr.memoryLimitBytes, timeUnixNano))

  return { resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ scope: SCOPE, metrics }] }] }
}

/** POST an OTLP metrics payload to the local collector's OTLP/HTTP receiver. */
async function postMetrics(endpoint: string, payload: OtlpMetricsPayload): Promise<void> {
  try {
    const res = await fetch(`${endpoint}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) core.warning(`cgroup metrics export failed: ${res.status} ${res.statusText}`)
  } catch (err) {
    core.warning(`cgroup metrics export failed: ${(err as Error).message}`)
  }
}

/** Env var flag telling a re-invocation of this action's entrypoint to run the poller loop instead of the normal action logic. */
export const CGROUP_POLLER_ENV = 'OTEL_COLLECT_CGROUP_POLLER'
export const CGROUP_POLLER_ENDPOINT_ENV = 'OTEL_COLLECT_CGROUP_ENDPOINT'

const PID_STATE = 'otel-cgroup-poller-pid'
const DEFAULT_INTERVAL_MS = 5000

/**
 * Entry point for the spawned poller process (invoked via CGROUP_POLLER_ENV):
 * sample cgroup stats and POST them every `intervalMs`, until SIGTERM/SIGINT
 * (sent by stopCgroupPoller), flushing one last sample before exiting.
 */
export function runCgroupPollerProcess(endpoint: string, intervalMs: number = DEFAULT_INTERVAL_MS): void {
  const startTimeNanos = process.hrtime.bigint()

  const tick = async (): Promise<void> => {
    const curr = readCgroupSnapshot()
    if (curr === null) return
    await postMetrics(endpoint, buildMetricsPayload(curr, startTimeNanos))
  }

  const timer = setInterval(() => void tick(), intervalMs)

  const shutdown = (): void => {
    clearInterval(timer)
    void tick().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  void tick()
}

/**
 * Spawn a detached process that re-runs this action's own entrypoint
 * (process.argv[1] — always dist/index.js, since the whole action bundles into
 * one file) with CGROUP_POLLER_ENV set, so it takes the poller branch in
 * index.ts's run() instead of the normal action logic. No-ops when this host has
 * no cgroup v2 filesystem (macOS/Windows runners, non-containerized jobs).
 */
export async function startCgroupPoller(otlpHttpEndpoint: string): Promise<void> {
  if (readCgroupSnapshot() === null) {
    core.info('No cgroup v2 filesystem found; skipping container CPU/memory metrics')
    return
  }

  const tmp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp'
  const logPath = path.join(tmp, 'otel-collect-cgroup-poller.log')
  const out = fs.openSync(logPath, 'a')

  const child = spawn(process.execPath, [process.argv[1]], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, [CGROUP_POLLER_ENV]: '1', [CGROUP_POLLER_ENDPOINT_ENV]: otlpHttpEndpoint }
  })
  child.unref()

  if (child.pid) {
    core.saveState(PID_STATE, String(child.pid))
    core.info(`Started cgroup metrics poller (pid ${child.pid}), logging to ${logPath}`)
  } else {
    core.warning('Failed to start cgroup metrics poller')
  }
}

/** Stop the poller daemon, giving it a moment to flush its last sample. */
export async function stopCgroupPoller(): Promise<void> {
  const pidRaw = core.getState(PID_STATE)
  if (!pidRaw) return
  const pid = Number(pidRaw)
  if (!Number.isInteger(pid)) return

  try {
    process.kill(pid, 'SIGTERM')
    core.info(`Sent SIGTERM to cgroup metrics poller (pid ${pid})`)
  } catch (err) {
    core.debug(`cgroup metrics poller already stopped: ${(err as Error).message}`)
  }
}
