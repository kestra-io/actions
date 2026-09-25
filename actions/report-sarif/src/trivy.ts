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
  type Finding
} from './finding.js'

export interface TrivyVulnerability {
  VulnerabilityID?: string
  PkgName?: string
  PkgIdentifier?: { PURL?: string }
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

export interface TrivyResult {
  Target?: string
  Class?: string
  Type?: string
  Vulnerabilities?: TrivyVulnerability[]
}

export interface TrivyReport {
  SchemaVersion?: number
  ArtifactName?: string
  Trivy?: { Version?: string }
  Results?: TrivyResult[]
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

function toFinding(report: TrivyReport, result: TrivyResult, vulnerability: TrivyVulnerability): Finding {
  const { score, version } = primaryScore(vulnerability.CVSS, vulnerability.SeveritySource)
  const severity = severityFromWord(vulnerability.Severity) ?? (score === undefined ? 'Unknown' : severityFromScore(score))

  return {
    tool: 'Trivy',
    toolVersion: report.Trivy?.Version ?? '',
    ruleId: vulnerability.VulnerabilityID ?? 'unknown',
    ruleName: result.Class ?? '',
    // Trivy's JSON has no SARIF level; derive one so the field means the same thing either way.
    level: severity === 'Critical' || severity === 'High' ? 'error' : severity === 'Unknown' ? 'none' : 'warning',
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
    fixStatus: vulnerability.Status
  }
}

export function flattenTrivy(report: TrivyReport): Finding[] {
  return (report.Results ?? []).flatMap(result =>
    (result.Vulnerabilities ?? []).map(vulnerability => toFinding(report, result, vulnerability))
  )
}
