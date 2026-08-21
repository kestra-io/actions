import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMetricsPayload, parseCpuMax, parseKeyValueStat, parseMemoryValue, type CgroupSnapshot } from './cgroup.js'

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

test('parseKeyValueStat parses cpu.stat', () => {
  const content = 'usage_usec 1234567\nuser_usec 1000000\nnr_periods 42\nnr_throttled 3\nthrottled_usec 5000\n'
  assert.deepEqual(parseKeyValueStat(content), {
    usage_usec: 1234567,
    user_usec: 1000000,
    nr_periods: 42,
    nr_throttled: 3,
    throttled_usec: 5000
  })
})

test('parseMemoryValue treats "max" as unlimited', () => {
  assert.equal(parseMemoryValue('max\n'), null)
  assert.equal(parseMemoryValue('134217728\n'), 134217728)
})

function snapshot(overrides: Partial<CgroupSnapshot> = {}): CgroupSnapshot {
  return {
    timeNanos: 0n,
    cpuUsageUsec: 0,
    cpuLimitCores: null,
    nrPeriods: null,
    nrThrottled: null,
    throttledUsec: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    ...overrides
  }
}

test('buildMetricsPayload emits container.cpu.time as a monotonic cumulative counter in seconds', () => {
  const payload = buildMetricsPayload(snapshot({ timeNanos: 5_000_000_000n, cpuUsageUsec: 2_000_000 }), 0n)
  const cpuTime = payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === 'container.cpu.time')
  assert.ok(cpuTime?.sum)
  assert.equal(cpuTime.sum?.dataPoints[0].asDouble, 2) // 2,000,000us -> 2s
  assert.equal(cpuTime.sum?.isMonotonic, true)
  assert.equal(cpuTime.sum?.aggregationTemporality, 2)
  assert.equal(cpuTime.sum?.dataPoints[0].startTimeUnixNano, '0')
  assert.equal(cpuTime.sum?.dataPoints[0].timeUnixNano, '5000000000')
})

test('buildMetricsPayload converts throttled_usec to seconds and keeps period counts raw', () => {
  const payload = buildMetricsPayload(snapshot({ nrPeriods: 42, nrThrottled: 3, throttledUsec: 5_000_000 }), 0n)
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
  assert.equal(metrics.find((m) => m.name === 'container.cpu.throttled.time')?.sum?.dataPoints[0].asDouble, 5)
  assert.equal(metrics.find((m) => m.name === 'container.cpu.throttled.periods')?.sum?.dataPoints[0].asDouble, 3)
  assert.equal(metrics.find((m) => m.name === 'container.cpu.periods')?.sum?.dataPoints[0].asDouble, 42)
})

test('buildMetricsPayload emits the cpu limit as a numeric gauge, not a resource attribute', () => {
  const payload = buildMetricsPayload(snapshot({ cpuLimitCores: 8 }), 0n)
  const limit = payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === 'container.cpu.limit')
  assert.equal(limit?.gauge?.dataPoints[0].asDouble, 8)
  assert.deepEqual(payload.resourceMetrics[0].resource.attributes, [])
})

test('buildMetricsPayload only emits optional metrics that have a value', () => {
  const payload = buildMetricsPayload(snapshot({ cpuUsageUsec: 100 }), 0n)
  const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name)
  assert.deepEqual(names, ['container.cpu.time'])
})

test('buildMetricsPayload emits throttling and memory metrics when present', () => {
  const payload = buildMetricsPayload(
    snapshot({
      cpuUsageUsec: 100,
      nrPeriods: 42,
      nrThrottled: 3,
      throttledUsec: 5_000_000,
      memoryUsageBytes: 1024,
      memoryLimitBytes: 2048,
      cpuLimitCores: 2
    }),
    0n
  )
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
