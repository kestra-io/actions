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
  /** How to fix it, when the producer says so — SARIF `help`, Trivy has none. */
  readonly remediation?: string
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

/**
 * OpenGrep and Semgrep both set the SARIF `shortDescription` to "<Tool> Finding: <rule id>" — and
 * for a rule loaded off disk the id in there is a runner temp path. It is never worth showing, so
 * it is dropped in favour of something a human wrote.
 */
export function isBoilerplateTitle(title: string): boolean {
  return /^[\w.-]+(\s+\w+)*\s+Finding:/i.test(title.trim())
}

/**
 * A readable name from a rule id. Takes the most specific segment of a dotted id, since the leading
 * ones are the language and category the file already records, and drops the repeat OpenGrep leaves
 * when a rule file is named after its rule:
 *
 *   dockerfile.security.missing-user-entrypoint.missing-user-entrypoint -> Missing user entrypoint
 *   kestra-mutable-action-tag                                           -> Kestra mutable action tag
 */
export function humaniseRuleId(ruleId: string): string {
  const segments = ruleId.split('.').filter(Boolean)
  const last = segments[segments.length - 1] ?? ruleId
  const words = last.replace(/[-_]+/g, ' ').trim()
  if (!words) return ruleId
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The first sentence of a description, when it is short enough to read as a title. */
export function firstSentence(text: string, maxLength = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length <= maxLength ? sentence : ''
}

/**
 * The name to show for a finding: what the producer wrote if it wrote anything useful, else the
 * opening sentence of the description, else the rule id made readable.
 */
export function ruleTitle(rawTitle: string, description: string, ruleId: string): string {
  const title = rawTitle.trim()
  if (title && !isBoilerplateTitle(title) && title !== ruleId) return title
  return firstSentence(description) || humaniseRuleId(ruleId)
}

/**
 * The data stream dataset for a tool: the first word of its name, lowercased. "Opengrep OSS"
 * becomes `opengrep` and "Trivy" becomes `trivy`, so each scanner gets its own `logs-<tool>-<ns>`
 * stream. A dataset may not contain a dash, which is why this is not simply the name slugified.
 */
export function datasetForTool(tool: string): string {
  const first = tool.toLowerCase().match(/[a-z0-9_]+/)?.[0]
  return first || 'unknown'
}
