import { credentials as grpcCredentials, Metadata } from '@grpc/grpc-js'
import { SpanKind, SpanStatusCode, TraceFlags, type HrTime } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { Resource } from '@opentelemetry/resources'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

/** Parse a comma separated "k=v,k2=v2" header string into a map. */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    headers[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return headers
}

function msToHr(ms: number): HrTime {
  const seconds = Math.trunc(ms / 1000)
  const nanos = Math.round((ms - seconds * 1000) * 1e6)
  return [seconds, nanos]
}

export function buildResource(serviceName: string): Resource {
  return new Resource({
    'service.name': serviceName,
    'cicd.pipeline.name': process.env.GITHUB_WORKFLOW ?? '',
    'vcs.repository.name': process.env.GITHUB_REPOSITORY ?? '',
    'github.run_id': process.env.GITHUB_RUN_ID ?? '',
    'github.run_attempt': process.env.GITHUB_RUN_ATTEMPT ?? '',
    'github.sha': process.env.GITHUB_SHA ?? '',
    'github.ref': process.env.GITHUB_REF ?? ''
  })
}

export interface SpanInput {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  startMs: number
  endMs: number
  conclusion: string | null
  attributes?: Record<string, string | number | boolean>
}

/** GitHub conclusion -> OTel status code. */
function statusOf(conclusion: string | null): SpanStatusCode {
  if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') {
    return SpanStatusCode.OK
  }
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
    return SpanStatusCode.ERROR
  }
  return SpanStatusCode.UNSET
}

/**
 * Hand-build a ReadableSpan with predetermined (deterministic) ids. The tracer
 * SDK generates random ids, so we bypass it and feed spans straight to the
 * exporter — the proven otel-cicd-action pattern.
 */
export function buildSpan(input: SpanInput, resource: Resource): ReadableSpan {
  const endMs = Number.isFinite(input.endMs) ? input.endMs : input.startMs
  const span = {
    name: input.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: input.traceId,
      spanId: input.spanId,
      traceFlags: TraceFlags.SAMPLED
    }),
    parentSpanId: input.parentSpanId,
    startTime: msToHr(input.startMs),
    endTime: msToHr(endMs),
    status: { code: statusOf(input.conclusion) },
    attributes: input.attributes ?? {},
    links: [],
    events: [],
    duration: msToHr(Math.max(0, endMs - input.startMs)),
    ended: true,
    resource,
    instrumentationLibrary: { name: 'kestra-io/actions/otel-collect', version: '1.0.0' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0
  }
  return span as unknown as ReadableSpan
}

/**
 * Normalize an OTLP endpoint for gRPC: strip the http(s) scheme and any signal
 * path (gRPC endpoints must be base URLs — a "/v1/traces" path is rejected), then
 * ensure a port (443 for TLS, 4317 for plaintext). Returns {target, secure}.
 */
export function grpcTarget(endpoint: string): { target: string; secure: boolean } {
  const secure = !endpoint.startsWith('http://')
  let host = endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!/:\d+$/.test(host)) {
    host = `${host}:${secure ? 443 : 4317}`
  }
  return { target: host, secure }
}

/** Base OTLP endpoint (scheme + host[:port], no signal path) for OTEL_EXPORTER_OTLP_ENDPOINT. */
export function baseEndpoint(endpoint: string): string {
  const { target, secure } = grpcTarget(endpoint)
  return `${secure ? 'https' : 'http'}://${target}`
}

/** Export the spans over OTLP/gRPC and flush. */
export async function exportSpans(
  spans: ReadableSpan[],
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs = 15000
): Promise<void> {
  const { target, secure } = grpcTarget(endpoint)

  const metadata = new Metadata()
  for (const [key, value] of Object.entries(headers)) {
    metadata.set(key, value)
  }

  const exporter = new OTLPTraceExporter({
    url: target,
    metadata,
    credentials: secure ? grpcCredentials.createSsl() : grpcCredentials.createInsecure()
  })

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    exporter.export(spans, (result) => {
      clearTimeout(timer)
      if (result.code !== 0) {
        // ExportResultCode.FAILED === 1
        // eslint-disable-next-line no-console
        console.error('OTLP export failed', result.error)
      }
      resolve()
    })
  })

  await exporter.shutdown().catch(() => undefined)
}
