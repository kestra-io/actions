/**
 * The normalised finding every reader produces, whatever format it read.
 *
 * SARIF is the common denominator — any scanner emits it — but it is lossy. Trivy's own JSON report
 * carries the advisory database, the publication date and a CVSS score per scoring vendor, none of
 * which survive the SARIF rendering, and all of which Elastic's vulnerability views have a place
 * for. So the optional fields below are the ones only a native report can fill.
 */

/**
 * Title case, matching what the third-party vulnerability integrations already write into this
 * cluster (`Critical`, `High`, ...). A finding shipped as `HIGH` would sit in its own bucket beside
 * theirs in the same Findings view rather than aggregating with them.
 */
export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Unknown'

/** One entry of Trivy's per-vendor CVSS map, e.g. `{ nvd: { V3Score: 7.5, V3Vector: "CVSS:3.1/..." } }`. */
export interface CvssScore {
  readonly V2Vector?: string
  readonly V2Score?: number
  readonly V3Vector?: string
  readonly V3Score?: number
}

export interface Finding {
  readonly tool: string
  readonly toolVersion: string
  readonly ruleId: string
  readonly ruleName: string
  readonly level: 'error' | 'warning' | 'note' | 'none'
  readonly severity: Severity
  readonly score?: number
  readonly scoreVersion?: string
  readonly title: string
  readonly description: string
  readonly helpUri?: string
  readonly tags: string[]
  readonly cwes: string[]
  readonly file?: string
  readonly startLine?: number
  readonly startColumn?: number
  readonly endLine?: number
  readonly snippet?: string
  readonly fingerprint?: string
  readonly packageName?: string
  readonly packageVersion?: string
  readonly packageFixedVersion?: string
  /** Native report only: the advisory database the finding came from. */
  readonly dataSource?: { readonly ID?: string; readonly Name?: string; readonly URL?: string }
  readonly publishedDate?: string
  readonly lastModifiedDate?: string
  /** Native report only: every scoring vendor's CVSS, keyed by vendor. */
  readonly cvss?: Record<string, CvssScore>
  readonly references?: string[]
  readonly purl?: string
  readonly fixStatus?: string
}

/** Producers spell the severity word however they like, so match on the upper cased form. */
const SEVERITY_WORDS: Record<string, Severity> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  MODERATE: 'Medium',
  LOW: 'Low',
  UNKNOWN: 'Unknown',
  NONE: 'Unknown'
}

export function severityFromWord(word: string | undefined): Severity | undefined {
  return SEVERITY_WORDS[String(word ?? '').toUpperCase()]
}

/** CVSS v3 qualitative bands, the scale `security-severity` is defined against. */
export function severityFromScore(score: number): Severity {
  if (score >= 9) return 'Critical'
  if (score >= 7) return 'High'
  if (score >= 4) return 'Medium'
  if (score > 0) return 'Low'
  return 'Unknown'
}

/**
 * The version the score is on, read off the vector prefix (`CVSS:3.1/AV:L/...`). Beats assuming 3.1
 * for a score that turns out to be a v4 or a v2 one.
 */
export function scoreVersion(vector: unknown): string | undefined {
  return /^CVSS:(\d+\.\d+)\//.exec(String(vector ?? ''))?.[1]
}

/** CWE identifiers arrive as free text: a bare "CWE-79", or a tag like "cwe:CWE-79: XSS". */
export function cweIds(values: string[]): string[] {
  const found = values.flatMap(value => value.toUpperCase().match(/CWE-\d+/g) ?? [])
  return [...new Set(found)]
}
