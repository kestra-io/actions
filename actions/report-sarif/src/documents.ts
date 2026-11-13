import * as path from 'node:path'
import { applyMetadata, prune, sha256 } from '../../../shared/elastic-core/src/document.js'
import type { GithubMetadata } from '../../../shared/elastic-core/src/github.js'
import { languageOf } from '../../../shared/elastic-core/src/language.js'
import {
  datasetForTool,
  rationaleOf,
  ruleSection,
  type Finding,
  type Severity
} from './finding.js'
import { LICENSE_TOOL } from './trivy.js'

/**
 * Turns a Finding into an ECS document shaped the way Elastic's security views read vulnerability
 * data: `vulnerability.*` for the finding itself, `package.*` for what it was found in, and
 * `resource.*` for what owns it. A repository is not a cloud resource, so resource.id is derived
 * from the repository name — stable across runs, which is what lets a transform collapse the
 * per-run stream into a latest-state index without the findings fanning out per workflow run.
 */
/** What the findings are: CVEs in dependencies, or rules a scanned file breaks. */
export type FindingType = 'vulnerabilities' | 'misconfigurations'

/** A container image reference split into what identifies it: `docker.io/kestra/kestra:latest`. */
export interface ImageRef {
  readonly name: string
  readonly tag: string
  /** The sha256 digest behind the tag at scan time, when the report says. */
  readonly digest?: string
}

/**
 * `<name>:<tag>` or `<name>@sha256:<digest>`; a bare name is `latest`. The last `:` after the last `/`
 * is the tag separator, so a registry port (`localhost:5000/x`) is not mistaken for one.
 */
export function parseImageRef(ref: string, digest?: string): ImageRef {
  const trimmed = ref.trim()
  const at = trimmed.indexOf('@')
  if (at !== -1) return { name: trimmed.slice(0, at), tag: trimmed.slice(at + 1), digest: digest ?? trimmed.slice(at + 1) }
  const slash = trimmed.lastIndexOf('/')
  const colon = trimmed.lastIndexOf(':')
  if (colon > slash) return { name: trimmed.slice(0, colon), tag: trimmed.slice(colon + 1) || 'latest', digest }
  return { name: trimmed, tag: 'latest', digest }
}

/** `kestra` for `docker.io/kestra/kestra`: the default `service.name` of an image scan. */
export function imageShortName(image: ImageRef): string {
  return image.name.split('/').filter(Boolean).pop() ?? image.name
}

export interface DocumentContext {
  /** Overrides the per-tool dataset when set; empty means `logs-<tool>-<namespace>`. */
  readonly dataset: string
  /** Set for a container image scan: the image stands in for the repository and its tag for the branch. */
  readonly image?: ImageRef
  readonly namespace: string
  readonly type: FindingType
  readonly github: GithubMetadata
  readonly scanTime: string
  readonly tags: string[]
  readonly metadata: Record<string, string>
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
 * number is deliberately in, since two hits of one rule in one file are two findings to fix. The
 * branch is in too, so a latest-state transform keyed on this id keeps one state per branch
 * (main and every releases/*) instead of the last branch scanned overwriting the others.
 */
export function findingId(finding: Finding, context: DocumentContext): string {
  // An image finding is keyed on the tag, not the digest: `latest` moving to a new build is the same
  // finding still open (or fixed), not a new one. The digest it was seen on is in container.image.hash.
  if (context.image) {
    return sha256(
      [context.image.name, context.image.tag, finding.tool, finding.ruleId, finding.ecosystem ?? finding.file ?? '', '', finding.packageName ?? ''].join('|')
    )
  }
  return sha256(
    [
      context.github.repository,
      context.github.refName ?? '',
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
 * the name is scoped to it, and to the branch, since the same dependency is tracked separately on
 * main and on each releases/* branch. The repository stays filterable through github.* and
 * organization.* either way.
 */
/**
 * An image is what the finding is on: `resource.repository` is the image name (what the tower groups
 * and assigns owners by), `sub_type` the Trivy result type (ubuntu, jar, python-pkg...), and the id is
 * stable per image × tag × type so a latest-state transform keeps one state per shipped tag.
 */
function imageResource(finding: Finding, image: ImageRef): Record<string, unknown> {
  const type = finding.ecosystem ?? languageOf(finding.file ?? '') ?? finding.file?.toLowerCase()
  const scope = `${image.name} (${image.tag})`
  // Trivy names the OS result after the image itself, "docker.io/kestra/kestra:latest (ubuntu 24.04)":
  // the image is already in the scope, so only the distribution is kept.
  const target = finding.file?.replace(/^\S+\s+\((.+)\)$/, '$1')
  return {
    id: sha256(`${image.name}|${image.tag}|${type ?? ''}`).slice(0, 32),
    name: target ? `${scope} / ${target}` : scope,
    type: 'container-image',
    sub_type: type,
    target: type,
    language: type,
    repository: image.name,
    url: `https://${image.name}`
  }
}

function resourceFor(finding: Finding, context: DocumentContext): Record<string, unknown> {
  if (context.image) return imageResource(finding, context.image)
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

  const branch = context.github.refName
  const scope = repository && branch ? `${repository} (${branch})` : repository
  return {
    id: sha256(`${repository}|${branch ?? ''}|${target}`).slice(0, 32),
    name: scope ? `${scope} / ${target}` : target,
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
function containerOf(image: ImageRef | undefined): Record<string, unknown> | undefined {
  if (!image) return undefined
  return { image: { name: image.name, tag: [image.tag], hash: image.digest ? { all: [image.digest] } : undefined } }
}

function common(finding: Finding, context: DocumentContext): Record<string, unknown> {
  const github = context.github
  return {
    '@timestamp': context.scanTime,
    container: containerOf(context.image),
    // The image is the service the scan is about; a `service.name=` in metadata still overrides it.
    service: context.image ? { name: imageShortName(context.image) } : undefined,
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
  if (context.type === 'misconfigurations') {
    const document = misconfiguration(finding, context, id)
    applyMetadata(document, context.metadata)
    return prune(document)
  }
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
      category: finding.tool === LICENSE_TOOL ? 'License' : finding.packageName ? 'Package Vulnerability' : 'Static Analysis',
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
      fix_status: finding.fixStatus,
      // Which jar or site-packages entry inside an image: the same CVE sits in several plugin jars.
      path: finding.packagePath
    },
    // Every reference the advisory lists, not just the primary one in vulnerability.reference.
    related: { references: finding.references }
  }

  applyMetadata(document, context.metadata)

  return prune(document)
}

/**
 * One `scan_completed` document per image scan, shipped even when nothing was found. A clean scan
 * otherwise leaves no trace in the stream, and the consumer keeping a latest state per image × tag
 * could not tell "clean" from "not scanned"; this is the evidence that lets it mark the previous
 * findings fixed. No `resource.sub_type`: it covers every result type of the image.
 */
export function scanSummary(context: DocumentContext, tool: string, toolVersion: string, count: number): Record<string, unknown> {
  const image = context.image
  if (!image) throw new Error('scanSummary needs an image context')
  const github = context.github
  const dataset = context.dataset || datasetForTool(tool)
  const scope = `${image.name} (${image.tag})`
  const document: Record<string, unknown> = {
    '@timestamp': context.scanTime,
    tags: context.tags,
    data_stream: { type: 'logs', dataset, namespace: context.namespace },
    ecs: { version: '8.11.0' },
    message: `${tool} scanned ${image.name}:${image.tag}: ${count} vulnerabilit${count === 1 ? 'y' : 'ies'}`,
    event: {
      kind: 'event',
      category: ['vulnerability'],
      type: ['info'],
      action: 'scan_completed',
      outcome: 'success',
      dataset,
      module: datasetForTool(tool),
      provider: 'github-actions',
      id: sha256([image.name, image.tag, tool, 'scan_completed'].join('|')),
      created: context.scanTime,
      sequence: Number(github.runId) || undefined
    },
    container: containerOf(image),
    service: { name: imageShortName(image) },
    observer: { vendor: tool, product: tool, version: toolVersion },
    resource: {
      id: sha256(`${image.name}|${image.tag}`).slice(0, 32),
      name: scope,
      type: 'container-image',
      repository: image.name,
      url: `https://${image.name}`
    },
    user: { name: github.triggeringActor || github.actor, id: github.actorId },
    organization: { name: github.repositoryOwner, id: github.repositoryOwnerId },
    github: structuredClone(github) as unknown as Record<string, unknown>,
    vulnerability: { scanner: { vendor: tool, version: toolVersion }, report_id: `${github.runId}-${github.runAttempt ?? 1}` },
    labels: { component: 'image' }
  }
  applyMetadata(document, context.metadata)
  return prune(document)
}
