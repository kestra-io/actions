import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authHeaders, bulkUrl, chunk, dataStreamName, sendBulk, toNdjson, validateDataStream } from './bulk.js'

test('bulkUrl accepts the bare ingest host, the /_es path, or the full URL', () => {
  const expected = 'https://abc.ingest.eu-west-1.aws.elastic.cloud:443/_es/_bulk'
  assert.equal(bulkUrl('https://abc.ingest.eu-west-1.aws.elastic.cloud:443'), expected)
  assert.equal(bulkUrl('https://abc.ingest.eu-west-1.aws.elastic.cloud:443/'), expected)
  assert.equal(bulkUrl('abc.ingest.eu-west-1.aws.elastic.cloud:443'), expected)
  assert.equal(bulkUrl('https://abc.ingest.eu-west-1.aws.elastic.cloud:443/_es'), expected)
  assert.equal(bulkUrl(' https://abc.ingest.eu-west-1.aws.elastic.cloud:443/_es/_bulk '), expected)
})

test('validateDataStream rejects targets the endpoint would silently drop', () => {
  assert.equal(validateDataStream(dataStreamName('security_scan.findings', 'github-actions')), null)
  assert.match(String(validateDataStream('metrics-foo-default')), /logs- data stream/)
  assert.match(String(validateDataStream('logs-Foo-default')), /rejects/)
})

test('toNdjson emits a create action per document and a trailing newline', () => {
  const body = toNdjson([{ a: 1 }, { b: 2 }], 'logs-x-default')
  assert.equal(
    body,
    '{"create":{"_index":"logs-x-default"}}\n{"a":1}\n{"create":{"_index":"logs-x-default"}}\n{"b":2}\n'
  )
})

test('chunk splits on the batch size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 2), [])
})

test('authHeaders takes the OTLP_HEADERS secret unchanged, or just the key', () => {
  assert.deepEqual(authHeaders('Authorization=ApiKey abc123', ''), { Authorization: 'ApiKey abc123' })
  assert.deepEqual(authHeaders('Authorization=ApiKey abc, x-tenant=kestra', ''), {
    Authorization: 'ApiKey abc',
    'x-tenant': 'kestra'
  })
  assert.deepEqual(authHeaders('', 'abc123'), { Authorization: 'ApiKey abc123' })
  // An explicit key wins, so a caller can override a headers secret that carries the wrong one.
  assert.deepEqual(authHeaders('Authorization=ApiKey stale', 'fresh'), { Authorization: 'ApiKey fresh' })
  assert.deepEqual(authHeaders('', ''), {}, 'nothing to authenticate with is caught by the caller')
})

test('sendBulk sends the ApiKey header and the ndjson content type', async () => {
  let seen: RequestInit | undefined
  await sendBulk({
    url: 'https://example.invalid/_es/_bulk',
    headers: { Authorization: 'ApiKey key' },
    body: 'payload',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen = init
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  })
  const headers = seen?.headers as Record<string, string>
  assert.equal(headers.Authorization, 'ApiKey key')
  assert.equal(headers['Content-Type'], 'application/x-ndjson')
  assert.equal(seen?.method, 'POST')
})

test('sendBulk retries a 503 and succeeds', async () => {
  let calls = 0
  await sendBulk({
    url: 'https://example.invalid/_es/_bulk',
    headers: { Authorization: 'ApiKey key' },
    body: 'payload',
    sleep: async () => {},
    fetchImpl: (async () => {
      calls += 1
      return new Response('', { status: calls === 1 ? 503 : 200 })
    }) as unknown as typeof fetch
  })
  assert.equal(calls, 2)
})

test('sendBulk does not retry a 400', async () => {
  let calls = 0
  await assert.rejects(
    sendBulk({
      url: 'https://example.invalid/_es/_bulk',
      headers: { Authorization: 'ApiKey key' },
      body: 'payload',
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1
        return new Response('only create actions are supported', { status: 400 })
      }) as unknown as typeof fetch
    }),
    /HTTP 400/
  )
  assert.equal(calls, 1)
})

test('sendBulk gives up after the last attempt', async () => {
  let calls = 0
  await assert.rejects(
    sendBulk({
      url: 'https://example.invalid/_es/_bulk',
      headers: { Authorization: 'ApiKey key' },
      body: 'payload',
      attempts: 2,
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1
        throw new Error('connect ECONNREFUSED')
      }) as unknown as typeof fetch
    }),
    /ECONNREFUSED/
  )
  assert.equal(calls, 2)
})
