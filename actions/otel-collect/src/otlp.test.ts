import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseEndpoint, grpcTarget, parseHeaders } from './otlp.js'

test('grpcTarget strips scheme and signal path, defaults TLS port', () => {
  assert.deepEqual(grpcTarget('https://otlp.example.com/v1/traces'), { target: 'otlp.example.com:443', secure: true })
  assert.deepEqual(grpcTarget('https://otlp.example.com'), { target: 'otlp.example.com:443', secure: true })
  assert.deepEqual(grpcTarget('https://otlp.example.com:4317'), { target: 'otlp.example.com:4317', secure: true })
  assert.deepEqual(grpcTarget('http://localhost:4317'), { target: 'localhost:4317', secure: false })
  assert.deepEqual(grpcTarget('http://localhost'), { target: 'localhost:4317', secure: false })
})

test('baseEndpoint returns scheme + host[:port] with no path', () => {
  assert.equal(baseEndpoint('https://otlp.example.com/v1/traces'), 'https://otlp.example.com:443')
  assert.equal(baseEndpoint('http://localhost:4317/v1/metrics'), 'http://localhost:4317')
})

test('parseHeaders splits comma-separated k=v pairs', () => {
  assert.deepEqual(parseHeaders('Authorization=ApiKey abc,x-tenant=foo'), {
    Authorization: 'ApiKey abc',
    'x-tenant': 'foo'
  })
  assert.deepEqual(parseHeaders(''), {})
})
