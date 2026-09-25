import { pct } from './model.js'
import type { CoverageSummary, ModuleTotals } from './summary.js'

function arrow(delta: number): string {
  if (delta > 0.005) return '▲'
  if (delta < -0.005) return '▼'
  return '▬'
}

function formatDelta(current: number, base: number | undefined): string {
  if (base === undefined) return ''
  const delta = Math.round((current - base) * 100) / 100
  const sign = delta > 0 ? '+' : ''
  return ` (${arrow(delta)} ${sign}${delta.toFixed(2)}pp)`
}

interface ModuleRow {
  readonly name: string
  readonly current?: ModuleTotals
  readonly base?: ModuleTotals
}

function moduleRows(current: CoverageSummary, base: CoverageSummary | undefined): ModuleRow[] {
  const names = new Set([...Object.keys(current.modules), ...Object.keys(base?.modules ?? {})])
  return [...names]
    .map(name => ({ name, current: current.modules[name], base: base?.modules[name] }))
    .sort((a, b) => {
      const deltaA = a.current && a.base ? pct(a.current.lines) - pct(a.base.lines) : 0
      const deltaB = b.current && b.base ? pct(b.current.lines) - pct(b.base.lines) : 0
      return deltaA - deltaB
    })
}

function rowLine(row: ModuleRow): string {
  if (!row.current) return `| ${row.name} | — | removed | — |`
  const linePct = pct(row.current.lines)
  const base = row.base ? pct(row.base.lines) : undefined
  const status = row.base ? '' : ' (new)'
  return `| ${row.name}${status} | ${row.current.lines.covered}/${row.current.lines.covered + row.current.lines.missed} | ${linePct.toFixed(2)}%${formatDelta(linePct, base)} |`
}

const COLLAPSE_THRESHOLD = 15

/**
 * Markdown for `comment-update`'s template input. Kept free of `{{`/`{%` so its nunjucks pass
 * leaves the table alone. Modules are sorted by the biggest coverage drop first, so a regression is
 * the first thing a reviewer sees rather than buried in an alphabetical list.
 */
export function buildComment(current: CoverageSummary, base: CoverageSummary | undefined): string {
  const linePct = pct(current.totals.lines)
  const baseLinePct = base ? pct(base.totals.lines) : undefined
  const lines: string[] = []

  lines.push(`**${linePct.toFixed(2)}%** line coverage${formatDelta(linePct, baseLinePct)}`)
  lines.push(`${current.totals.lines.covered}/${current.totals.lines.covered + current.totals.lines.missed} lines covered`)
  if (!base) lines.push('_No develop baseline yet — this will compare against develop once it has a coverage run._')
  lines.push('')

  const rows = moduleRows(current, base)
  const header = '| Module | Lines | Coverage |\n| --- | --- | --- |'
  const body = rows.map(rowLine).join('\n')

  if (rows.length > COLLAPSE_THRESHOLD) {
    lines.push('<details><summary>Coverage by module</summary>\n')
    lines.push(header)
    lines.push(body)
    lines.push('\n</details>')
  } else {
    lines.push('**Coverage by module**\n')
    lines.push(header)
    lines.push(body)
  }

  return lines.join('\n')
}
