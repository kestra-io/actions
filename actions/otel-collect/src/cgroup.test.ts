import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildMetricsPayload,
  normalizeV1MemoryLimit,
  parseCpuMax,
  parseCpuQuotaV1,
  parseKeyValueStat,
  parseMemoryValueV2,
  type CgroupSnapshot
} from './cgroup.js'

test('parseCpuMax reads "<quota> <period>" microseconds into a core-count limit', () => {
  assert.equal(parseCpuMax('800000 100000'), 8)
  assert.equal(parseCpuMax('50000 100000'), 0.5)
})

test('parseCpuMax treats "max" as unlimited', () => {
  assert.equal(parseCpuMax('max 100000'), null)
})

test('parseCpuMax rejects malformed content instead of throwing', () => {
  assert.equal(parseCpuMax(''), null)
  assert.equal(parseCpuMax('not-a-number 100000'), null)
  assert.equal(parseCpuMax('100000 0'), null)
})

test('parseCpuQuotaV1 combines cfs_quota_us/cfs_period_us into a core-count limit', () => {
  assert.equal(parseCpuQuotaV1('400000', '100000'), 4)
})

test('parseCpuQuotaV1 treats -1 quota as unlimited', () => {
  assert.equal(parseCpuQuotaV1('-1', '100000'), null)
})

test('parseKeyValueStat parses cgroup v2 cpu.stat', () => {
  const content = 'usage_usec 1234567\nuser_usec 1000000\nsystem_usec 234567\nnr_periods 42\nnr_throttled 3\nthrottled_usec 5000\n'
  assert.deepEqual(parseKeyValueStat(content), {
    usage_usec: 1234567,
    user_usec: 1000000,
    system_usec: 234567,
    nr_periods: 42,
    nr_throttled: 3,
    throttled_usec: 5000
  })
})

test('parseKeyValueStat parses cgroup v1 cpu.stat (nanosecond throttled_time)', () => {
  assert.deepEqual(parseKeyValueStat('nr_periods 10\nnr_throttled 1\nthrottled_time 2000000\n'), {
    nr_periods: 10,
    nr_throttled: 1,
    throttled_time: 2000000
  })
})

test('parseMemoryValueV2 treats "max" as unlimited', () => {
  assert.equal(parseMemoryValueV2('max\n'), null)
  assert.equal(parseMemoryValueV2('134217728\n'), 134217728)
})

test('normalizeV1MemoryLimit treats the huge v1 sentinel as unlimited', () => {
  assert.equal(normalizeV1MemoryLimit(9223372036854771712), null)
  assert.equal(normalizeV1MemoryLimit(134217728), 134217728)
})

function snapshot(overrides: Partial<CgroupSnapshot> = {}): CgroupSnapshot {
  return {
    timeNanos: 0n,
    cpuUsageUsec: 0,
    cpuUserUsec: null,
    cpuSystemUsec: null,
    cpuLimitCores: null,
    nrPeriods: null,
    nrThrottled: null,
    throttledUsec: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    ...overrides
  }
}

test('buildMetricsPayload always emits cumulative container.cpu.time from raw kernel usage', () => {
  const curr = snapshot({ timeNanos: 5_000_000_000n, cpuUsageUsec: 2_000_000 })
  const payload = buildMetricsPayload(curr, null, 0n)
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
  const cpuTime = metrics.find((m) => m.name === 'container.cpu.time')
  assert.ok(cpuTime?.sum)
  assert.equal(cpuTime.sum?.dataPoints[0].asDouble, 2) // 2,000,000us -> 2s
  assert.equal(cpuTime.sum?.isMonotonic, true)
  assert.equal(cpuTime.sum?.aggregationTemporality, 2)
})

test('buildMetricsPayload omits container.cpu.utilization on the first sample (no prev)', () => {
  const curr = snapshot({ cpuLimitCores: 4, cpuUsageUsec: 1000 })
  const payload = buildMetricsPayload(curr, null, 0n)
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
  assert.equal(
    metrics.find((m) => m.name === 'container.cpu.utilization'),
    undefined
  )
})

test('buildMetricsPayload computes container.cpu.utilization as a fraction of the limit from the usage delta', () => {
  // 4-core limit, 2 cores' worth of usage accrued over 1 second -> 0.5 utilization.
  const prev = snapshot({ timeNanos: 0n, cpuUsageUsec: 0, cpuLimitCores: 4 })
  const curr = snapshot({ timeNanos: 1_000_000_000n, cpuUsageUsec: 2_000_000, cpuLimitCores: 4 })
  const payload = buildMetricsPayload(curr, prev, 0n)
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
  const utilization = metrics.find((m) => m.name === 'container.cpu.utilization')
  assert.ok(utilization?.gauge)
  assert.equal(utilization.gauge?.dataPoints[0].asDouble, 0.5)
})

test('buildMetricsPayload never reports utilization above 1 for a job pinned at its limit', () => {
  // 8-core limit, fully saturated for 1 second -> 8,000,000us of usage -> utilization 1.0, not 2.
  const prev = snapshot({ timeNanos: 0n, cpuUsageUsec: 0, cpuLimitCores: 8 })
  const curr = snapshot({ timeNanos: 1_000_000_000n, cpuUsageUsec: 8_000_000, cpuLimitCores: 8 })
  const payload = buildMetricsPayload(curr, prev, 0n)
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
  const utilization = metrics.find((m) => m.name === 'container.cpu.utilization')
  assert.equal(utilization?.gauge?.dataPoints[0].asDouble, 1)
})

test('buildMetricsPayload omits container.cpu.utilization when the limit is unknown', () => {
  const prev = snapshot({ timeNanos: 0n, cpuUsageUsec: 0, cpuLimitCores: null })
  const curr = snapshot({ timeNanos: 1_000_000_000n, cpuUsageUsec: 2_000_000, cpuLimitCores: null })
  const payload = buildMetricsPayload(curr, prev, 0n)
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
  assert.equal(
    metrics.find((m) => m.name === 'container.cpu.utilization'),
    undefined
  )
})

test('buildMetricsPayload only emits optional metrics that have a value', () => {
  const curr = snapshot({ cpuUsageUsec: 100 })
  const payload = buildMetricsPayload(curr, null, 0n)
  const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name)
  assert.deepEqual(names, ['container.cpu.time'])
})

test('buildMetricsPayload emits throttling and memory metrics when present', () => {
  const curr = snapshot({
    cpuUsageUsec: 100,
    nrPeriods: 42,
    nrThrottled: 3,
    throttledUsec: 5_000_000,
    memoryUsageBytes: 1024,
    memoryLimitBytes: 2048,
    cpuLimitCores: 2
  })
  const payload = buildMetricsPayload(curr, null, 0n)
  const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name)
  assert.deepEqual(
    new Set(names),
    new Set([
      'container.cpu.time',
      'container.cpu.periods',
      'container.cpu.throttled.periods',
      'container.cpu.throttled.time',
      'container.cpu.limit',
      'container.memory.usage',
      'container.memory.limit'
    ])
  )
})
