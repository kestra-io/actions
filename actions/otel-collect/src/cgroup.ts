import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'

/**
 * `hostmetrics` (collector.ts) reads /proc/stat, which is not cgroup-aware: on a
 * Kubernetes runner it reports the whole node's CPUs, not the pod's CPU limit —
 * a 4-CPU-limited pod shows up with the node's full CPU count. This module reads
 * the pod's own cgroup instead, so "CPU busy" can be expressed as a fraction of
 * the limit actually enforced on this job, and throttling (nr_throttled) — which
 * no node-wide reading can show at all — becomes visible.
 *
 * Runs as a second detached process (mirroring collector.ts's daemon), because it
 * needs to keep sampling on an interval to compute a rate from cumulative kernel
 * counters. It POSTs OTLP/HTTP JSON straight into the hostmetrics collector's own
 * OTLP receiver (see CGROUP_METRICS_ENDPOINT / collector.ts's buildConfig) rather
 * than exporting directly, so the collector's existing `resource` processor
 * stamps every github.* / host.name / service.instance.id attribute for us —
 * these metrics land pre-joined to the hostmetrics ones without duplicating that list.
 */

const V2_ROOT = '/sys/fs/cgroup'
// Some distros mount the v1 cpu and cpuacct controllers together, some separately.
const V1_CPU_ROOTS = ['/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpuacct']
const V1_MEMORY_ROOT = '/sys/fs/cgroup/memory'
// cgroup v1 has no "unlimited" sentinel string; it reports a huge byte count
// instead (typically ~2^63, sometimes rounded to a page boundary).
const V1_UNLIMITED_MEMORY_THRESHOLD = 1e18

export interface CgroupSnapshot {
  /** Monotonic sample time (process.hrtime.bigint()), used for rate math — never wall clock. */
  timeNanos: bigint
  /** Cumulative CPU time consumed since the cgroup was created, in microseconds. */
  cpuUsageUsec: number
  cpuUserUsec: number | null
  cpuSystemUsec: number | null
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

/** Parse cgroup v2's `cpu.max` ("<quota> <period>" in microseconds, or "max <period>" when unlimited) into a core-count limit. */
export function parseCpuMax(content: string): number | null {
  const [quotaRaw, periodRaw] = content.trim().split(/\s+/)
  if (!quotaRaw || quotaRaw === 'max' || !periodRaw) return null
  const quota = Number(quotaRaw)
  const period = Number(periodRaw)
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null
  return quota / period
}

/** Combine cgroup v1's split `cpu.cfs_quota_us` (-1 = unlimited) / `cpu.cfs_period_us` into a core-count limit. */
export function parseCpuQuotaV1(quotaRaw: string, periodRaw: string): number | null {
  const quota = Number(quotaRaw.trim())
  const period = Number(periodRaw.trim())
  if (!Number.isFinite(quota) || quota < 0 || !Number.isFinite(period) || period <= 0) return null
  return quota / period
}

/** Parse a cgroup "key value\n..." stat file (cpu.stat in both v1 and v2) into a map. */
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

/** Parse a cgroup v2 byte-count file (`memory.current`/`memory.max`, "max" = unlimited). */
export function parseMemoryValueV2(content: string): number | null {
  const trimmed = content.trim()
  if (trimmed === 'max') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/** Normalize a cgroup v1 memory limit, treating the huge "no limit" sentinel as null. */
export function normalizeV1MemoryLimit(bytes: number): number | null {
  return bytes >= V1_UNLIMITED_MEMORY_THRESHOLD ? null : bytes
}

function tryRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read the current process's cgroup CPU/memory stats (v2 preferred, v1
 * fallback). Returns null when there's no cgroup filesystem at all — macOS,
 * Windows, and non-containerized GitHub-hosted runners — so callers can no-op
 * instead of exporting a permanently-empty metric.
 */
export function readCgroupSnapshot(nowNanos: bigint = process.hrtime.bigint()): CgroupSnapshot | null {
  const v2CpuStat = tryRead(`${V2_ROOT}/cpu.stat`)
  if (v2CpuStat !== null) {
    const stat = parseKeyValueStat(v2CpuStat)
    const cpuMax = tryRead(`${V2_ROOT}/cpu.max`)
    const memCurrent = tryRead(`${V2_ROOT}/memory.current`)
    const memMax = tryRead(`${V2_ROOT}/memory.max`)
    return {
      timeNanos: nowNanos,
      cpuUsageUsec: stat.usage_usec ?? 0,
      cpuUserUsec: stat.user_usec ?? null,
      cpuSystemUsec: stat.system_usec ?? null,
      cpuLimitCores: cpuMax !== null ? parseCpuMax(cpuMax) : null,
      nrPeriods: stat.nr_periods ?? null,
      nrThrottled: stat.nr_throttled ?? null,
      throttledUsec: stat.throttled_usec ?? null,
      memoryUsageBytes: memCurrent !== null ? parseMemoryValueV2(memCurrent) : null,
      memoryLimitBytes: memMax !== null ? parseMemoryValueV2(memMax) : null
    }
  }

  for (const root of V1_CPU_ROOTS) {
    const usageNs = tryRead(`${root}/cpuacct.usage`)
    if (usageNs === null) continue
    const quota = tryRead(`${root}/cpu.cfs_quota_us`)
    const period = tryRead(`${root}/cpu.cfs_period_us`)
    const statRaw = tryRead(`${root}/cpu.stat`)
    const stat = statRaw !== null ? parseKeyValueStat(statRaw) : {}
    const memUsage = tryRead(`${V1_MEMORY_ROOT}/memory.usage_in_bytes`)
    const memLimit = tryRead(`${V1_MEMORY_ROOT}/memory.limit_in_bytes`)
    return {
      timeNanos: nowNanos,
      cpuUsageUsec: Number(usageNs.trim()) / 1000,
      cpuUserUsec: null,
      cpuSystemUsec: null,
      cpuLimitCores: quota !== null && period !== null ? parseCpuQuotaV1(quota, period) : null,
      nrPeriods: stat.nr_periods ?? null,
      nrThrottled: stat.nr_throttled ?? null,
      // v1's cpu.stat reports throttled_time in nanoseconds, unlike v2's throttled_usec.
      throttledUsec: stat.throttled_time !== undefined ? stat.throttled_time / 1000 : null,
      memoryUsageBytes: memUsage !== null ? parseMemoryValueV2(memUsage) : null,
      memoryLimitBytes: memLimit !== null ? normalizeV1MemoryLimit(Number(memLimit.trim())) : null
    }
  }

  return null
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
 * Build an OTLP/HTTP JSON metrics payload from a cgroup snapshot. The counters
 * (cpu time, throttling) are raw cumulative totals straight from the kernel, so
 * they're emitted with CUMULATIVE temporality against a fixed start time — no
 * delta needed. `container.cpu.utilization` is the exception: it's a rate, so it
 * needs the delta between two samples (usage / elapsed wall time / limit) and is
 * omitted on the very first sample (no `prev` yet) or when the limit is unknown.
 */
export function buildMetricsPayload(curr: CgroupSnapshot, prev: CgroupSnapshot | null, startTimeNanos: bigint): OtlpMetricsPayload {
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
  if (curr.cpuLimitCores !== null) metrics.push(gauge('container.cpu.limit', '{cpu}', curr.cpuLimitCores, timeUnixNano))
  if (curr.memoryUsageBytes !== null) metrics.push(gauge('container.memory.usage', 'By', curr.memoryUsageBytes, timeUnixNano))
  if (curr.memoryLimitBytes !== null) metrics.push(gauge('container.memory.limit', 'By', curr.memoryLimitBytes, timeUnixNano))

  if (prev !== null && curr.cpuLimitCores !== null && curr.cpuLimitCores > 0) {
    const elapsedNanos = curr.timeNanos - prev.timeNanos
    if (elapsedNanos > 0n) {
      const deltaUsageUsec = curr.cpuUsageUsec - prev.cpuUsageUsec
      const elapsedUsec = Number(elapsedNanos) / 1000
      const utilization = deltaUsageUsec / elapsedUsec / curr.cpuLimitCores
      metrics.push(gauge('container.cpu.utilization', '1', utilization, timeUnixNano))
    }
  }

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
  let prev: CgroupSnapshot | null = null

  const tick = async (): Promise<void> => {
    const curr = readCgroupSnapshot()
    if (curr === null) return
    await postMetrics(endpoint, buildMetricsPayload(curr, prev, startTimeNanos))
    prev = curr
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
 * index.ts's run() instead of the normal action logic. No-ops when this host
 * has no cgroup filesystem (macOS/Windows runners, non-containerized jobs).
 */
export async function startCgroupPoller(otlpHttpEndpoint: string): Promise<void> {
  if (readCgroupSnapshot() === null) {
    core.debug('No cgroup filesystem found; skipping container CPU/memory metrics')
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
