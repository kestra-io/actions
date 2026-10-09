/**
 * The "scan completed" document: one per scope a scanner step covered, shipped on every run,
 * including the runs that found nothing.
 *
 * Findings alone cannot say a finding was fixed. Each run re-emits every current failure, so a
 * finding that stops being reported was either fixed or simply not scanned this time — and when a
 * fix removes the last finding of a scope, the next run emits nothing at all, which reads exactly
 * like a scan that never ran. This document is the positive signal: "this scope was scanned at this
 * @timestamp, and N findings were current". A finding of the same scope with an older @timestamp
 * than a successful summary is fixed.
 *
 * It must never read as a finding. It carries no `event.id`, no `event.category`, no `rule.*`, no
 * `vulnerability.*` and no `result.evaluation`, and `event.action: scan_completed` is what a
 * latest-state transform filters it out on.
 *
 * The scope:
 * - `target` for a scanner that enumerates its targets (Trivy): one document per target, with the
 *   same resource.id / resource.name as that target's vulnerabilities.
 * - `branch` otherwise (OpenGrep, TruffleHog): the repository on the branch scanned, narrowed by
 *   whatever `metadata` the step carries (labels.component, ...), which is applied to the summary
 *   exactly as to the findings.
 * - `artifact` for a target-enumerating scanner whose report listed no target at all: the scan ran,
 *   but there is no target to join on; `scan.artifact` says what was scanned.
 */

import { applyMetadata, prune, sha256 } from '../../../shared/elastic-core/src/document.js'
import { branchScopeName, targetResource, type DocumentContext } from './documents.js'
import { datasetForTool, type Finding } from './finding.js'

/** What a report says about the scan itself, independent of what it found. */
export interface ScanInfo {
  readonly tool: string
  readonly toolVersion: string
  /** Every target the scanner looked at, clean or not. Only set by a scanner that lists them (Trivy). */
  readonly targets?: string[]
  /** What the scanner was pointed at, e.g. Trivy's ArtifactName. */
  readonly artifact?: string
}

export type ScanOutcome = 'success' | 'failure'

export type ScanScope = 'target' | 'branch' | 'artifact'

export interface SummaryInput {
  readonly findings: Finding[]
  readonly scans: ScanInfo[]
  /** The scanner the step ran, for when no report names it: an empty report, or none at all. */
  readonly scanner: string
  readonly outcome: ScanOutcome
}

export function parseOutcome(value: string): ScanOutcome | undefined {
  const normalised = value.trim().toLowerCase()
  if (normalised === '' || normalised === 'success') return 'success'
  // GitHub step outcomes: anything but success means the scan cannot be trusted to be complete.
  if (['failure', 'cancelled', 'skipped', 'error'].includes(normalised)) return 'failure'
  return undefined
}

function sameTool(a: string, b: string): boolean {
  return datasetForTool(a) === datasetForTool(b)
}

function branchResource(context: DocumentContext): Record<string, unknown> {
  const { repository, refName, serverUrl } = context.github
  const repositoryUrl = repository ? `${serverUrl}/${repository}` : undefined
  return {
    id: sha256(`${repository}|${refName ?? ''}`).slice(0, 32),
    name: branchScopeName(context),
    type: 'github-repository',
    sub_type: 'branch',
    repository,
    repository_url: repositoryUrl,
    url: repositoryUrl
  }
}

function summaryDocument(
  context: DocumentContext,
  tool: string,
  toolVersion: string,
  outcome: ScanOutcome,
  scope: ScanScope,
  resource: Record<string, unknown>,
  count: number,
  artifact: string | undefined
): Record<string, unknown> {
  const github = context.github
  const dataset = context.dataset || datasetForTool(tool)
  const where = String(resource.name ?? github.repository ?? '')
  const document: Record<string, unknown> = {
    '@timestamp': context.scanTime,
    tags: context.tags,
    data_stream: { type: 'logs', dataset, namespace: context.namespace },
    ecs: { version: '8.11.0' },
    message:
      outcome === 'success'
        ? `${tool} scan completed on ${where}: ${count} finding(s)`
        : `${tool} scan did not complete on ${where}; its findings, if any, are not a complete picture`,
    event: {
      kind: 'event',
      action: 'scan_completed',
      type: ['end'],
      outcome,
      dataset,
      module: datasetForTool(tool),
      provider: 'github-actions',
      created: context.scanTime,
      sequence: Number(github.runId) || undefined
    },
    observer: { vendor: tool, product: tool, version: toolVersion },
    resource,
    scan: {
      scope,
      type: context.type,
      artifact,
      // Absent on a failed scan: a count would claim a coverage the scan never had.
      findings_count: outcome === 'success' ? count : undefined
    },
    user: { name: github.triggeringActor || github.actor, id: github.actorId },
    organization: { name: github.repositoryOwner, id: github.repositoryOwnerId },
    github: structuredClone(github) as unknown as Record<string, unknown>
  }
  applyMetadata(document, context.metadata)
  return prune(document)
}

/**
 * One summary per scanner and scope. A step normally runs one scanner; a call that ships reports
 * from several gets one set of summaries per scanner, each landing in that scanner's data stream.
 */
export function buildSummaries(input: SummaryInput, context: DocumentContext): Record<string, unknown>[] {
  const tools: { tool: string; toolVersion: string }[] = []
  const remember = (tool: string, toolVersion: string): void => {
    if (!tool || tool === 'unknown') return
    const known = tools.find(entry => sameTool(entry.tool, tool))
    if (!known) tools.push({ tool, toolVersion })
  }
  for (const scan of input.scans) remember(scan.tool, scan.toolVersion)
  for (const finding of input.findings) remember(finding.tool, finding.toolVersion)
  if (tools.length === 0 && input.scanner.trim()) remember(input.scanner.trim(), '')

  return tools.flatMap(({ tool, toolVersion }) => {
    const findings = input.findings.filter(finding => sameTool(finding.tool, tool))
    const scans = input.scans.filter(scan => sameTool(scan.tool, tool))
    const artifact = scans.map(scan => scan.artifact).find(Boolean)

    if (input.outcome === 'failure') {
      return [summaryDocument(context, tool, toolVersion, 'failure', 'branch', branchResource(context), findings.length, artifact)]
    }

    const enumeratesTargets = scans.some(scan => scan.targets !== undefined)
    if (!enumeratesTargets) {
      return [summaryDocument(context, tool, toolVersion, 'success', 'branch', branchResource(context), findings.length, artifact)]
    }

    const targets = [
      ...new Set([
        ...scans.flatMap(scan => scan.targets ?? []),
        ...findings.map(finding => finding.file).filter((file): file is string => Boolean(file))
      ])
    ]
    if (targets.length === 0) {
      return [summaryDocument(context, tool, toolVersion, 'success', 'artifact', branchResource(context), findings.length, artifact)]
    }
    return targets.map(target =>
      summaryDocument(
        context,
        tool,
        toolVersion,
        'success',
        'target',
        targetResource(target, context),
        findings.filter(finding => finding.file === target).length,
        artifact
      )
    )
  })
}
