import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConfig } from './collector.js'

const config = (): string => buildConfig('https://abc.ingest.europe-west1.gcp.elastic.cloud', { Authorization: 'ApiKey x' }, 'svc', 42, 'wf', 'job')

test('host metrics are scraped every 60 s with the receiver name of the Serverless node collector', () => {
  const yaml = config()
  assert.match(yaml, /^receivers:\n {2}host_metrics:\n/)
  assert.match(yaml, /collection_interval: 60s/)
  assert.match(yaml, /receivers: \[host_metrics, otlp\]/)
  assert.match(yaml, /exporters: \[otlp_grpc\]/)
})

test('the namespace of every metric is gha', () => {
  assert.match(config(), /key: data_stream\.namespace\n {8}value: "gha"/)
})

test('on Linux the CPU is averaged over the cores and the node filters apply', { skip: process.platform !== 'linux' }, () => {
  const yaml = config()
  assert.match(yaml, /system\.cpu\.time:\n {12}enabled: false/)
  assert.match(yaml, /metrics_transform\/host_cpu:/)
  assert.match(yaml, /processors: \[resource_detection, resource\/cloud, resource, transform\/host_os, metrics_transform\/host_cpu, batch\]/)
  assert.match(yaml, /processes: \{\}/)
  assert.doesNotMatch(yaml, /paging/)
  assert.match(yaml, /fs_types: \[ext4, xfs\]/)
})
