import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { GithubMetadata } from './github.js'
import {
  datasetForTool,
  languageOf,
  rationaleOf,
  ruleSection,
  type Finding,
  type Severity
} from './finding.js'

/**
 * Turns a Finding into an ECS document shaped the way Elastic's security views read vulnerability
 * data: `vulnerability.*` for the finding itself, `package.*` for what it was found in, and
 * `resource.*` for what owns it. A repository is not a cloud resource, so resource.id is derived
 * from the repository name — stable across runs, which is what lets a transform collapse the
 * per-run stream into a latest-state index without the findings fanning out per workflow run.
 */
/** What the findings are: CVEs in dependencies, or rules a scanned file breaks. */
export type FindingType = 'vulnerabilities' | 'misconfigurations'

export interface DocumentContext {
  /** Overrides the per-tool dataset when set; empty means `logs-<tool>-<namespace>`. */
  readonly dataset: string
  readonly namespace: string
  readonly type: FindingType
  readonly github: GithubMetadata
  readonly scanTime: string
  readonly tags: string[]
  readonly metadata: Record<string, string>
}

function sha256(input: string): string {
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

/**
 * The 0-100 scale the vulnerability integrations in this cluster already use for `event.severity`
 * (Critical 99, High 73, ...). These are band constants, not the CVSS score scaled up: most
 * findings arrive with no score at all, and a sortable severity is wanted regardless.
 */
const SEVERITY_SCORE: Record<Severity, number> = { Critical: 99, High: 73, Medium: 47, Low: 21, Unknown: 0 }

/**
 * Which advisory database the id comes from. Trivy reports GHSA ids for language packages that have
 * no CVE assigned, and a static analysis rule id belongs to no database at all — so this, and
 * `vulnerability.cve` with it, is absent more often than not.
 */
export function enumerationOf(ruleId: string): 'CVE' | 'GHSA' | undefined {
  if (/^CVE-/i.test(ruleId)) return 'CVE'
  if (/^GHSA-/i.test(ruleId)) return 'GHSA'
  return undefined
}

/**
 * Stable across runs: the same finding in the same place reports the same id every scan, so
 * repeated CI runs are a time series of one finding rather than a new finding each time. The line
 * number is deliberately in, since two hits of one rule in one file are two findings to fix.
 */
export function findingId(finding: Finding, context: DocumentContext): string {
  return sha256(
    [
      context.github.repository,
      finding.tool,
      finding.ruleId,
      finding.file ?? '',
      finding.startLine ?? '',
      finding.packageName ?? ''
    ].join('|')
  )
}

/**
 * Only for findings that point at a tracked file. A package vulnerability's location is the built
 * artifact it was scanned in (build/libs/plugin.jar), which is not in the tree at that revision, so
 * linking to it would produce a 404 on every dependency finding.
 */
function sourceUrl(finding: Finding, context: DocumentContext): string | undefined {
  const { repository, sha, serverUrl } = context.github
  if (!finding.file || finding.packageName || !repository || !sha) return undefined
  const line = finding.startLine ? `#L${finding.startLine}` : ''
  return `${serverUrl}/${repository}/blob/${sha}/${finding.file}${line}`
}

function prune(value: Record<string, unknown>): Record<string, unknown> {
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

/** Each scanner lands in its own data stream, so one tool's volume never buries another's. */
export function datasetOf(finding: Finding, context: DocumentContext): string {
  return context.dataset || datasetForTool(finding.tool)
}

function location(finding: Finding): string {
  if (!finding.file) return ''
  return finding.startLine ? `${finding.file}:${finding.startLine}` : finding.file
}

/**
 * What the finding is *on*, which differs by kind.
 *
 * A misconfiguration is on a file: a repository-level resource makes every finding in a scan share
 * one id, which collapses the Findings list into one row repeated, and the file is what someone
 * opens to fix it.
 *
 * A vulnerability is on a dependency, and Trivy reports its target as the ecosystem rather than a
 * path — "Java" for a jar scan. "Java" alone says nothing about which repository is affected, so
 * the name is scoped to it. The repository stays filterable through github.* and organization.*
 * either way.
 */
function resourceFor(finding: Finding, context: DocumentContext): Record<string, unknown> {
  const repository = context.github.repository
  const target = finding.file
  const repositoryUrl = repository ? `${context.github.serverUrl}/${repository}` : undefined

  if (context.type === 'misconfigurations' && target) {
    return {
      id: sha256(`${repository}|${target}`).slice(0, 32),
      name: target,
      type: 'file',
      // Rendered as "Resource Type" in the list.
      sub_type: languageOf(target),
      path: target,
      directory: path.dirname(target),
      file: path.basename(target),
      line: finding.startLine,
      language: languageOf(target),
      repository,
      repository_url: repositoryUrl,
      url: sourceUrl(finding, context)
    }
  }

  if (!target) {
    return {
      id: sha256(repository).slice(0, 32),
      name: repository,
      type: 'github-repository',
      sub_type: 'repository',
      repository,
      repository_url: repositoryUrl,
      url: repositoryUrl
    }
  }

  return {
    id: sha256(`${repository}|${target}`).slice(0, 32),
    name: repository ? `${repository} / ${target}` : target,
    type: 'github-repository',
    sub_type: languageOf(target) ?? target.toLowerCase(),
    target,
    language: languageOf(target) ?? target.toLowerCase(),
    repository,
    repository_url: repositoryUrl,
    url: repositoryUrl
  }
}

/**
 * Shared by both document shapes: everything about where the finding was seen rather than what it
 * is.
 */
function common(finding: Finding, context: DocumentContext): Record<string, unknown> {
  const github = context.github
  return {
    '@timestamp': context.scanTime,
    tags: context.tags,
    data_stream: { type: 'logs', dataset: datasetOf(finding, context), namespace: context.namespace },
    ecs: { version: '8.11.0' },
    file: finding.file
      ? { path: finding.file, name: path.basename(finding.file), directory: path.dirname(finding.file) }
      : undefined,
    log: finding.startLine ? { origin: { file: { name: finding.file, line: finding.startLine } } } : undefined,
    url: { full: sourceUrl(finding, context) },
    observer: { vendor: finding.tool, product: finding.tool, version: finding.toolVersion },
    resource: resourceFor(finding, context),
    user: { name: github.triggeringActor || github.actor, id: github.actorId },
    organization: { name: github.repositoryOwner, id: github.repositoryOwnerId },
    github: structuredClone(github) as unknown as Record<string, unknown>,
    sarif: {
      level: finding.level,
      ruleId: finding.ruleId,
      ruleName: finding.ruleName,
      fingerprint: finding.fingerprint,
      snippet: finding.snippet,
      startLine: finding.startLine,
      startColumn: finding.startColumn,
      endLine: finding.endLine
    }
  }
}

/**
 * A rule a scanned file breaks, shaped like the cloud posture findings already in this cluster:
 * `event.category: configuration`, a `result.evaluation`, and the rule itself under `rule.*` rather
 * than `vulnerability.*`. Static analysis has no CVE and no package, so forcing it into the
 * vulnerability shape would leave most of that shape empty and put it in the wrong Findings view.
 */
function misconfiguration(finding: Finding, context: DocumentContext, id: string): Record<string, unknown> {
  const github = context.github
  const where = location(finding)
  return {
    ...common(finding, context),
    // Matches the posture findings' own phrasing, so both read the same way in a results list.
    message: `Rule "${finding.title}": failed${where ? ` at ${where}` : ''}`,
    event: {
      kind: 'state',
      category: ['configuration'],
      type: ['info'],
      // A reported finding is a rule that did not hold; a passing rule is never shipped.
      outcome: 'failure',
      dataset: datasetOf(finding, context),
      module: datasetForTool(finding.tool),
      provider: 'github-actions',
      id,
      created: context.scanTime,
      severity: SEVERITY_SCORE[finding.severity],
      sequence: Number(github.runId) || undefined
    },
    result: { evaluation: 'failed' },
    rule: {
      id: finding.ruleId,
      name: finding.title,
      description: finding.description,
      // The sentences after the opening one: the rule states itself first, then explains itself.
      rationale: rationaleOf(finding.description),
      references: finding.helpUri,
      remediation: finding.remediation,
      tags: finding.tags,
      version: finding.toolVersion,
      // Rendered as "Framework Section".
      section: ruleSection(finding.tags, finding.ruleId),
      // Synthesised: a ruleset is the closest thing static analysis has to a benchmark, and the
      // Findings view groups by it. `rule_number` is the list's "Rule Number" column, and a rule
      // id is the only number a scanner rule has.
      benchmark: {
        id: datasetForTool(finding.tool),
        name: finding.tool,
        version: finding.toolVersion,
        rule_number: finding.ruleId
      }
    },
    // Kept so a misconfiguration can still be filtered by weakness class alongside a CVE.
    vulnerability: { cwe: finding.cwes, severity: finding.severity }
  }
}

export function toDocument(finding: Finding, context: DocumentContext): Record<string, unknown> {
  const id = findingId(finding, context)
  if (context.type === 'misconfigurations') return prune(misconfiguration(finding, context, id))
  const github = context.github
  const enumeration = enumerationOf(finding.ruleId)
  const document: Record<string, unknown> = {
    ...common(finding, context),
    message: finding.title || finding.description,
    event: {
      // `event` rather than `state`, matching the vulnerability integrations already feeding this
      // cluster — findings from every source should answer the same `event.kind` filter.
      kind: 'event',
      category: ['vulnerability'],
      type: ['info'],
      dataset: datasetOf(finding, context),
      module: datasetForTool(finding.tool),
      provider: 'github-actions',
      id,
      created: context.scanTime,
      severity: SEVERITY_SCORE[finding.severity],
      // The run this finding was observed in. Two scans of the same commit share the finding id and
      // differ here, which is how a stale finding is told apart from a current one.
      sequence: Number(github.runId) || undefined
    },
    vulnerability: {
      id: finding.ruleId,
      title: finding.title,
      description: finding.description,
      severity: finding.severity,
      reference: finding.helpUri,
      // Set only for a real CVE. A GHSA-only advisory and a static analysis rule both leave it
      // empty, which is why nothing downstream should key on it — `vulnerability.id` always exists.
      cve: enumeration === 'CVE' ? finding.ruleId : undefined,
      category: finding.packageName ? 'Package Vulnerability' : 'Static Analysis',
      classification: finding.score !== undefined ? 'CVSS' : undefined,
      enumeration,
      cwe: finding.cwes,
      // Native-report only. The flyout has a panel for each: the advisory database behind the
      // finding, when it was published, and every scoring vendor's CVSS rather than just the one
      // that won. SARIF carries none of them, so a SARIF-sourced finding leaves them empty.
      data_source: finding.dataSource,
      published_date: finding.publishedDate,
      last_modified_date: finding.lastModifiedDate,
      cvss: finding.cvss,
      report_id: `${github.runId}-${github.runAttempt ?? 1}`,
      scanner: { vendor: finding.tool, version: finding.toolVersion },
      score: finding.score === undefined ? undefined : { base: finding.score, version: finding.scoreVersion }
    },
    package: {
      name: finding.packageName,
      version: finding.packageVersion,
      fixed_version: finding.packageFixedVersion,
      reference: finding.purl,
      // "fixed", "affected", "will_not_fix" — whether a fixed_version exists says less than this.
      fix_status: finding.fixStatus
    },
    // Every reference the advisory lists, not just the primary one in vulnerability.reference.
    related: { references: finding.references }
  }

  for (const [key, value] of Object.entries(context.metadata)) {
    setPath(document, key.includes('.') ? key : `labels.${key}`, value)
  }

  return prune(document)
}
