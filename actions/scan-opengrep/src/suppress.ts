import type { OpengrepReport, OpengrepResult } from './findings.js'

/**
 * A rule that is right in general but wrong in a specific context.
 *
 * Excluding the whole rule is the blunt instrument, and usually the wrong one: dropping
 * github-actions-mutable-action-tag outright silenced 7 genuine third-party findings
 * (dorny/paths-filter@v4, docker/login-action@v4, …) to hide the 1 kestra-io/actions@main
 * reference that was deliberate. This suppresses the finding, not the rule.
 */
export interface IgnoreRule {
  /** Substring of the rule id. Rule ids are long and end in a doubled segment, so exact match is hostile. */
  readonly rule: string
  /** Regular expression tested against the matched source line. */
  readonly match: string
  /** Why. Printed in the log so a suppression is never invisible. */
  readonly reason?: string
}

export interface Suppression {
  readonly rule: IgnoreRule
  readonly count: number
}

export interface SuppressionResult {
  readonly report: OpengrepReport
  readonly suppressions: Suppression[]
  readonly total: number
}

function matcher(rule: IgnoreRule): RegExp {
  try {
    return new RegExp(rule.match)
  } catch (error) {
    throw new Error(`Invalid 'match' regular expression in ignore-findings for rule '${rule.rule}': ${(error as Error).message}`)
  }
}

export function isSuppressed(result: OpengrepResult, rule: IgnoreRule, pattern: RegExp): boolean {
  if (!result.check_id?.includes(rule.rule)) return false
  // extra.lines is the matched source. Falling back to the empty string means a finding with no
  // snippet is never suppressed, which is the safe direction.
  return pattern.test(result.extra?.lines ?? '')
}

/**
 * Drop findings matching any ignore rule, and report how many each one removed.
 *
 * The counts matter: a suppression that silently stops matching (the rule id changed upstream, the
 * pattern no longer fits) should be visible as a zero, not discovered months later.
 */
export function applySuppressions(report: OpengrepReport, rules: IgnoreRule[]): SuppressionResult {
  if (rules.length === 0) return { report, suppressions: [], total: 0 }

  const patterns = rules.map(rule => ({ rule, pattern: matcher(rule) }))
  const counts = new Map<IgnoreRule, number>(rules.map(rule => [rule, 0]))

  const kept = (report.results ?? []).filter(result => {
    const hit = patterns.find(({ rule, pattern }) => isSuppressed(result, rule, pattern))
    if (!hit) return true
    counts.set(hit.rule, (counts.get(hit.rule) ?? 0) + 1)
    return false
  })

  const suppressions = rules.map(rule => ({ rule, count: counts.get(rule) ?? 0 }))
  return {
    report: { ...report, results: kept },
    suppressions,
    total: suppressions.reduce((sum, entry) => sum + entry.count, 0)
  }
}

export function describeSuppression({ rule, count }: Suppression): string {
  const reason = rule.reason ? ` — ${rule.reason}` : ''
  return `${count} finding(s) matching /${rule.match}/ in ${rule.rule}${reason}`
}
