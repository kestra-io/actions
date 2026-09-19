import type { OpengrepReport, OpengrepResult, Summary } from './findings.js'

export interface CommentRow {
  readonly severity: string
  readonly rule: string
  readonly location: string
  readonly message: string
}

export interface CommentModel {
  readonly total: number
  readonly shown: CommentRow[]
  readonly overflow: number
}

const SEVERITY_ORDER: Record<string, number> = { ERROR: 0, WARNING: 1, INFO: 2 }

/**
 * Collapse a finding message to a single table cell. A raw OpenGrep message is multi-line and may
 * contain a pipe, either of which silently breaks the markdown table it lands in.
 */
export function cellText(message: string, maxLength = 300): string {
  return message.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, maxLength)
}

function compare(a: OpengrepResult, b: OpengrepResult): number {
  const bySeverity = (SEVERITY_ORDER[a.extra.severity] ?? 9) - (SEVERITY_ORDER[b.extra.severity] ?? 9)
  if (bySeverity !== 0) return bySeverity
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return a.start.line - b.start.line
}

export function buildCommentModel(report: OpengrepReport, maxRows: number): CommentModel {
  const results = [...(report.results ?? [])].sort(compare)
  return {
    total: results.length,
    shown: results.slice(0, maxRows).map(result => ({
      severity: result.extra.severity,
      rule: result.check_id,
      location: `${result.path}:${result.start.line}`,
      message: cellText(result.extra.message)
    })),
    overflow: Math.max(0, results.length - maxRows)
  }
}

export function renderTable(rows: CommentRow[]): string[] {
  if (rows.length === 0) return []
  return [
    '| Severity | Rule | Location | Message |',
    '| :--- | :--- | :--- | :--- |',
    ...rows.map(row => `| ${row.severity} | \`${row.rule}\` | \`${row.location}\` | ${row.message} |`)
  ]
}

export interface SummaryContext {
  readonly mode: string
  readonly rulesSource: string
  readonly engineVersion: string
  readonly summary: Summary
  readonly model: CommentModel
  readonly artifactName: string
}

export function renderStepSummary(context: SummaryContext): string {
  const { mode, rulesSource, engineVersion, summary, model, artifactName } = context
  const lines = [
    '### 🔎 OpenGrep',
    '',
    `\`${mode}\` scan · ${rulesSource} rules · OpenGrep ${engineVersion} · ` +
      `${summary.filesScanned} file(s) scanned`,
    '',
    `**${summary.total}** finding(s): ${summary.ERROR} error, ${summary.WARNING} warning, ${summary.INFO} info.`,
    ''
  ]

  if (summary.total > 0) {
    lines.push(...renderTable(model.shown))
    if (model.overflow > 0) {
      lines.push('', `_… and ${model.overflow} more, see the \`${artifactName}\` artifact._`)
    }
  }

  if (summary.parseErrors > 0) {
    lines.push('', `_${summary.parseErrors} file(s) only partially parsed; findings in those files may be incomplete._`)
  }

  return lines.join('\n')
}
