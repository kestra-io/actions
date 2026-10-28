/**
 * Trivy's own JSON report.
 *
 * Preferred over its SARIF rendering for Trivy scans, because SARIF drops exactly the fields
 * Elastic's vulnerability flyout has panels for: the advisory database behind the finding
 * (`DataSource`), when it was published, and the CVSS score each scoring vendor assigned. It also
 * carries proper `CweIDs` rather than CWEs smuggled through free-text rule tags.
 */

import {
  cweIds,
  scoreVersion,
  severityFromScore,
  severityFromWord,
  type CvssScore,
  type Finding,
  type Severity
} from './finding.js'

export interface TrivyVulnerability {
  VulnerabilityID?: string
  PkgName?: string
  PkgIdentifier?: { PURL?: string }
  PkgPath?: string
  InstalledVersion?: string
  FixedVersion?: string
  Status?: string
  Title?: string
  Description?: string
  Severity?: string
  SeveritySource?: string
  PrimaryURL?: string
  PublishedDate?: string
  LastModifiedDate?: string
  CweIDs?: string[]
  References?: string[]
  DataSource?: { ID?: string; Name?: string; URL?: string }
  CVSS?: Record<string, CvssScore>
}

export interface TrivyLicense {
  Severity?: string
  Category?: string
  PkgName?: string
  FilePath?: string
  Name?: string
  Confidence?: number
  Link?: string
}

export interface TrivyResult {
  Target?: string
  Class?: string
  Type?: string
  Vulnerabilities?: TrivyVulnerability[]
  Licenses?: TrivyLicense[]
}

export interface TrivyReport {
  SchemaVersion?: number
  ArtifactName?: string
  ArtifactType?: string
  Trivy?: { Version?: string }
  Metadata?: { OS?: { Family?: string; Name?: string }; RepoDigests?: string[]; RepoTags?: string[] }
  Results?: TrivyResult[]
}

/** The sha256 digest the image was pulled by, when the report carries one (`Metadata.RepoDigests`). */
export function imageDigest(report: TrivyReport): string | undefined {
  for (const entry of report.Metadata?.RepoDigests ?? []) {
    const digest = /@(sha256:[0-9a-f]{64})$/.exec(entry)?.[1]
    if (digest) return digest
  }
  return undefined
}

/** A SARIF log has `runs`, a Trivy report has `Results` and a `SchemaVersion`. */
export function isTrivyReport(value: unknown): value is TrivyReport {
  if (typeof value !== 'object' || value === null) return false
  const report = value as TrivyReport
  return Array.isArray(report.Results) && typeof report.SchemaVersion === 'number'
}

/**
 * Trivy scores the same CVE differently per vendor. `SeveritySource` names the one it chose to
 * derive `Severity` from, so that is the score to surface; nvd is the conventional fallback, and
 * failing both any vendor beats none. The whole map still ships, so the flyout can show the spread.
 */
export function primaryScore(
  cvss: Record<string, CvssScore> | undefined,
  severitySource: string | undefined
): { score?: number; version?: string } {
  if (!cvss) return {}
  const order = [severitySource, 'nvd', ...Object.keys(cvss)].filter((vendor): vendor is string => Boolean(vendor))
  for (const vendor of order) {
    const entry = cvss[vendor]
    if (!entry) continue
    if (typeof entry.V3Score === 'number') return { score: entry.V3Score, version: scoreVersion(entry.V3Vector) ?? '3.1' }
    if (typeof entry.V2Score === 'number') return { score: entry.V2Score, version: '2.0' }
  }
  return {}
}

function levelOf(severity: Severity): Finding['level'] {
  return severity === 'Critical' || severity === 'High' ? 'error' : severity === 'Unknown' ? 'none' : 'warning'
}

function toFinding(report: TrivyReport, result: TrivyResult, vulnerability: TrivyVulnerability): Finding {
  const { score, version } = primaryScore(vulnerability.CVSS, vulnerability.SeveritySource)
  const severity = severityFromWord(vulnerability.Severity) ?? (score === undefined ? 'Unknown' : severityFromScore(score))

  return {
    tool: 'Trivy',
    toolVersion: report.Trivy?.Version ?? '',
    ruleId: vulnerability.VulnerabilityID ?? 'unknown',
    ruleName: result.Class ?? '',
    // Trivy's JSON has no SARIF level; derive one so the field means the same thing either way.
    level: levelOf(severity),
    severity,
    score,
    scoreVersion: score === undefined ? undefined : version,
    title: vulnerability.Title ?? vulnerability.VulnerabilityID ?? '',
    description: vulnerability.Description ?? '',
    helpUri: vulnerability.PrimaryURL,
    tags: [result.Type, result.Class].filter((tag): tag is string => Boolean(tag)),
    cwes: cweIds(vulnerability.CweIDs ?? []),
    file: result.Target,
    packageName: vulnerability.PkgName,
    packageVersion: vulnerability.InstalledVersion,
    packageFixedVersion: vulnerability.FixedVersion,
    dataSource: vulnerability.DataSource,
    publishedDate: vulnerability.PublishedDate,
    lastModifiedDate: vulnerability.LastModifiedDate,
    cvss: vulnerability.CVSS,
    references: vulnerability.References,
    purl: vulnerability.PkgIdentifier?.PURL,
    fixStatus: vulnerability.Status,
    ecosystem: result.Type,
    resultClass: result.Class,
    packagePath: vulnerability.PkgPath
  }
}

/** Vendor of license findings, kept apart from the CVEs in `logs-trivy-*` through `scanner.vendor`. */
export const LICENSE_TOOL = 'Trivy License'

function toLicenseFinding(report: TrivyReport, result: TrivyResult, license: TrivyLicense): Finding {
  const severity = severityFromWord(license.Severity) ?? 'Unknown'
  const name = license.Name ?? 'unknown'
  const category = license.Category ?? ''

  return {
    tool: LICENSE_TOOL,
    toolVersion: report.Trivy?.Version ?? '',
    ruleId: name,
    ruleName: result.Class ?? '',
    level: levelOf(severity),
    severity,
    title: `${name} license`,
    description: `${license.PkgName ?? license.FilePath ?? 'A dependency'} is licensed under ${name}${category ? `, classified ${category}` : ''}`,
    helpUri: license.Link,
    tags: [result.Type, result.Class, license.Category].filter((tag): tag is string => Boolean(tag)),
    cwes: [],
    file: license.FilePath || result.Target,
    packageName: license.PkgName,
    ecosystem: result.Type,
    resultClass: result.Class
  }
}

export interface TrivyOptions {
  /**
   * Drop OS package vulnerabilities the distribution has not fixed (`Class: os-pkgs`, no `FixedVersion`).
   * An image scan reports hundreds of them (every CVE Debian marks as unimportant or won't-fix), and
   * nothing can be done about them short of changing the base image; language packages keep theirs.
   */
  readonly dropUnfixedOs?: boolean
}

/** The vulnerabilities `dropUnfixedOs` leaves out of a report, for the log line. */
export function unfixedOsCount(report: TrivyReport): number {
  return (report.Results ?? [])
    .filter(result => result.Class === 'os-pkgs')
    .reduce((count, result) => count + (result.Vulnerabilities ?? []).filter(v => !v.FixedVersion).length, 0)
}

export function flattenTrivy(report: TrivyReport, options: TrivyOptions = {}): Finding[] {
  return (report.Results ?? []).flatMap(result => [
    ...(result.Vulnerabilities ?? [])
      .filter(vulnerability => !(options.dropUnfixedOs && result.Class === 'os-pkgs' && !vulnerability.FixedVersion))
      .map(vulnerability => toFinding(report, result, vulnerability)),
    // Low is the permissive licenses (MIT, Apache, ...): one finding per dependency, never actionable.
    ...(result.Licenses ?? [])
      .filter(license => severityFromWord(license.Severity) !== 'Low')
      .map(license => toLicenseFinding(report, result, license))
  ])
}
