/**
 * SARIF 2.1.0 reader, narrowed to what a security scanner actually emits.
 *
 * The format is deliberately open ended: severity can arrive as `level`, as a CVSS score in
 * `properties["security-severity"]`, or as a bare tag, and the producers we care about each pick a
 * different one. Trivy tags rules with the severity word and repeats the CVSS score; OpenGrep sets
 * only `level`. flatten() collapses all of that into one shape so the document builder never has to
 * know which tool wrote the file.
 */

export type SarifLevel = 'error' | 'warning' | 'note' | 'none'

/**
 * Title case, matching what the third-party vulnerability integrations already write into this
 * cluster (`Critical`, `High`, ...). A finding shipped as `HIGH` would sit in its own bucket beside
 * theirs in the same Findings view rather than aggregating with them.
 */
export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Unknown'

interface SarifText {
  text?: string
}

export interface SarifRule {
  id?: string
  name?: string
  shortDescription?: SarifText
  fullDescription?: SarifText
  help?: SarifText & { markdown?: string }
  helpUri?: string
  defaultConfiguration?: { level?: SarifLevel }
  properties?: Record<string, unknown>
}

export interface SarifResult {
  ruleId?: string
  ruleIndex?: number
  level?: SarifLevel
  message?: SarifText
  locations?: {
    physicalLocation?: {
      artifactLocation?: { uri?: string }
      region?: { startLine?: number; startColumn?: number; endLine?: number; snippet?: SarifText }
    }
  }[]
  partialFingerprints?: Record<string, string>
  fingerprints?: Record<string, string>
  properties?: Record<string, unknown>
}

export interface SarifRun {
  tool?: { driver?: { name?: string; version?: string; semanticVersion?: string; rules?: SarifRule[] } }
  results?: SarifResult[]
}

export interface SarifLog {
  version?: string
  runs?: SarifRun[]
}

export interface Finding {
  readonly tool: string
  readonly toolVersion: string
  readonly ruleId: string
  readonly ruleName: string
  readonly level: SarifLevel
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

const LEVEL_SEVERITY: Record<SarifLevel, Severity> = {
  error: 'High',
  warning: 'Medium',
  note: 'Low',
  none: 'Unknown'
}

function text(value: SarifText | undefined): string {
  return value?.text?.trim() ?? ''
}

function stringsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return typeof value === 'string' ? [value] : []
}

/** CVSS v3 qualitative bands, the scale `security-severity` is defined against. */
export function severityFromScore(score: number): Severity {
  if (score >= 9) return 'Critical'
  if (score >= 7) return 'High'
  if (score >= 4) return 'Medium'
  if (score > 0) return 'Low'
  return 'Unknown'
}

function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Trivy renders the package a CVE was found in as a labelled block in the result message rather
 * than as structured fields, so the only way to fill package.* — the columns Elastic's vulnerability
 * views are built around — is to read it back out.
 */
export function parseTrivyPackage(message: string): Pick<Finding, 'packageName' | 'packageVersion' | 'packageFixedVersion'> {
  const field = (label: string): string | undefined =>
    new RegExp(`^${label}:\\s*(.+)$`, 'im').exec(message)?.[1]?.trim() || undefined
  return {
    packageName: field('Package'),
    packageVersion: field('Installed Version'),
    packageFixedVersion: field('Fixed Version')
  }
}

/** CWE identifiers arrive as free text: a bare "CWE-79", or a tag like "cwe:CWE-79: XSS". */
export function cweIds(values: string[]): string[] {
  const found = values.flatMap(value => value.toUpperCase().match(/CWE-\d+/g) ?? [])
  return [...new Set(found)]
}

/**
 * Trivy carries the CVSS vector alongside the score, and its prefix names the version the score is
 * on (`CVSS:3.1/AV:L/...`). Reading it beats assuming 3.1 for a score that turns out to be a v4 or
 * a v2 one.
 */
export function scoreVersion(vector: unknown): string | undefined {
  return /^CVSS:(\d+\.\d+)\//.exec(String(vector ?? ''))?.[1]
}

function resolveRule(run: SarifRun, result: SarifResult): SarifRule | undefined {
  const rules = run.tool?.driver?.rules ?? []
  if (typeof result.ruleIndex === 'number' && rules[result.ruleIndex]) return rules[result.ruleIndex]
  return rules.find(rule => rule.id === result.ruleId)
}

function toFinding(run: SarifRun, result: SarifResult): Finding {
  const driver = run.tool?.driver ?? {}
  const rule = resolveRule(run, result)
  const properties = { ...(rule?.properties ?? {}), ...(result.properties ?? {}) }
  const tags = stringsOf(properties.tags)

  const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning'
  const score = numberOf(properties['security-severity'])
  // Order matters. A tag is the producer stating the severity outright (Trivy), a score is the
  // producer stating CVSS and letting the reader band it, and `level` is the SARIF default that
  // every producer sets whether or not it means anything.
  const tagged = tags.map(tag => SEVERITY_WORDS[tag.toUpperCase()]).find(Boolean)
  const severity = tagged ?? (score !== undefined ? severityFromScore(score) : LEVEL_SEVERITY[level])

  const location = result.locations?.[0]?.physicalLocation
  const message = text(result.message)
  const fingerprints = { ...(result.partialFingerprints ?? {}), ...(result.fingerprints ?? {}) }

  return {
    tool: driver.name ?? 'unknown',
    toolVersion: driver.semanticVersion ?? driver.version ?? '',
    ruleId: result.ruleId ?? rule?.id ?? 'unknown',
    ruleName: rule?.name ?? result.ruleId ?? '',
    level,
    severity,
    score,
    scoreVersion: score === undefined ? undefined : (scoreVersion(properties.cvssv3_vector) ?? '3.1'),
    title: text(rule?.shortDescription) || message.split('\n')[0] || (result.ruleId ?? ''),
    description: text(rule?.fullDescription) || message,
    helpUri: rule?.helpUri,
    tags,
    cwes: cweIds([...tags, ...stringsOf(properties.cwe)]),
    file: location?.artifactLocation?.uri,
    startLine: location?.region?.startLine,
    startColumn: location?.region?.startColumn,
    endLine: location?.region?.endLine,
    snippet: text(location?.region?.snippet) || undefined,
    fingerprint: Object.values(fingerprints)[0],
    ...parseTrivyPackage(message)
  }
}

export function flatten(log: SarifLog): Finding[] {
  return (log.runs ?? []).flatMap(run => (run.results ?? []).map(result => toFinding(run, result)))
}
