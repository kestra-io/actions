/** Newline separated `key=value` pairs, the shape every multi-line list input here takes. */
export function parsePairs(raw: string): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    if (key) pairs[key] = trimmed.slice(separator + 1).trim()
  }
  return pairs
}

/**
 * Comma separated `k=v` headers, the exact format `otel-instrument` and `otel-export-trace` take
 * for `otlp-headers` — so the same OTLP_HEADERS secret can be handed to this action unchanged.
 */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    if (key) headers[key] = trimmed.slice(separator + 1).trim()
  }
  return headers
}

export function parseList(raw: string, separator = ','): string[] {
  return raw
    .split(separator)
    .map(entry => entry.trim())
    .filter(Boolean)
}

/** core.getBooleanInput throws on an empty value; a composite forwarding an unset input gives one. */
export function parseBoolean(raw: string, fallback = false): boolean {
  const value = raw.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}
