import { createHash } from 'node:crypto'

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Set `value` at a dotted path, creating objects on the way. Elasticsearch does expand dotted field
 * names in a source document, but not when the same document also carries the expanded object — so
 * everything is written expanded, once.
 */
export function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.').filter(Boolean)
  if (keys.length === 0) return
  let node = target
  for (const key of keys.slice(0, -1)) {
    const next = node[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys[keys.length - 1]] = value
}

/** A dotted key is written at that path, an undotted one lands under `labels`. */
export function applyMetadata(document: Record<string, unknown>, metadata: Record<string, string>): void {
  for (const [key, value] of Object.entries(metadata)) {
    setPath(document, key.includes('.') ? key : `labels.${key}`, value)
  }
}

/** Optional fields are omitted rather than indexed empty. */
export function prune(value: Record<string, unknown>): Record<string, unknown> {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === '' || (Array.isArray(entry) && entry.length === 0)) {
      delete value[key]
      continue
    }
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const nested = prune(entry as Record<string, unknown>)
      if (Object.keys(nested).length === 0) delete value[key]
    }
  }
  return value
}
