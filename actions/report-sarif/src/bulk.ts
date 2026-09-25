import { parseHeaders } from './inputs.js'

/**
 * The Elastic Cloud managed _bulk input: the same ingest host as the Managed OTLP Endpoint, with
 * /_es appended. It emulates a subset of the Elasticsearch _bulk API and the subset is strict —
 * `create` actions only, `logs-` targets only, whole batches accepted or rejected atomically.
 *
 * See https://www.elastic.co/docs/reference/opentelemetry/managed-inputs/elasticsearch-bulk
 */

/** Anything not prefixed `logs-` is accepted by the endpoint and then silently dropped. */
export function dataStreamName(dataset: string, namespace: string): string {
  return `logs-${dataset}-${namespace}`
}

export function validateDataStream(name: string): string | null {
  if (!name.startsWith('logs-')) return `target '${name}' is not a logs- data stream; the endpoint would drop it silently`
  if (!/^[a-z0-9_.-]+$/.test(name)) return `target '${name}' contains characters Elasticsearch rejects in an index name`
  return null
}

/**
 * Accepts whatever the Elastic Cloud console hands over: the bare ingest host the OTLP exporters
 * use, that host with /_es already on it, or the full _bulk URL.
 */
export function bulkUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (absolute.endsWith('/_bulk')) return absolute
  if (absolute.endsWith('/_es')) return `${absolute}/_bulk`
  return `${absolute}/_es/_bulk`
}

export function toNdjson(documents: Record<string, unknown>[], index: string): string {
  // `create` is the only action the endpoint accepts; `index` and `update` are 400s.
  const action = JSON.stringify({ create: { _index: index } })
  return documents.map(document => `${action}\n${JSON.stringify(document)}\n`).join('')
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

export interface SendOptions {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly attempts?: number
  readonly timeoutMs?: number
  readonly onRetry?: (message: string) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly fetchImpl?: typeof fetch
}

const RETRYABLE = new Set([429, 502, 503, 504])

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A batch is all-or-nothing, so a retry cannot half-succeed — but it can duplicate, since the
 * endpoint does not deduplicate by _id. Duplicates are the acceptable side of that trade: a
 * transform keying on event.id collapses them, whereas a dropped batch is a finding nobody sees.
 */
export async function sendBulk(options: SendOptions): Promise<void> {
  const attempts = options.attempts ?? 3
  const sleep = options.sleep ?? wait
  const send = options.fetchImpl ?? fetch
  let lastError = ''

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status = 0
    try {
      const response = await send(options.url, {
        method: 'POST',
        headers: { ...options.headers, 'Content-Type': 'application/x-ndjson' },
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000)
      })
      status = response.status
      if (response.ok) return
      lastError = `HTTP ${status}: ${(await response.text()).slice(0, 500)}`
    } catch (error) {
      lastError = (error as Error).message
    }

    // A 400 is a malformed payload or an unsupported action: retrying sends the same bytes again.
    if (status !== 0 && !RETRYABLE.has(status)) break
    if (attempt < attempts) {
      options.onRetry?.(`attempt ${attempt}/${attempts} failed (${lastError}), retrying`)
      await sleep(2 ** attempt * 500)
    }
  }

  throw new Error(lastError || 'the bulk request failed')
}

/**
 * The endpoint authenticates exactly like the Managed OTLP Endpoint it shares a host with, so the
 * OTLP_HEADERS secret already wired into these workflows works unchanged. `apiKey` is the shorthand
 * for a caller that only has the key itself.
 */
export function authHeaders(rawHeaders: string, apiKey: string): Record<string, string> {
  const headers = parseHeaders(rawHeaders)
  if (apiKey) headers.Authorization = `ApiKey ${apiKey}`
  return headers
}
