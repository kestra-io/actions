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
  /** Regular expression tested against the matched source line, or against matchNearest's line. */
  readonly match: string
  /**
   * Test `match` against the nearest preceding line matching this pattern, rather than the
   * finding's own line.
   *
   * Needed when the thing that makes a finding acceptable is not on the line that triggered it.
   * `secrets-inherit` flags the `secrets: inherit` line, but whether that is acceptable depends on
   * the `uses:` several lines above naming the workflow the secrets are handed to.
   *
   * Nearest, not a window: taking the closest preceding match means a job calling a trusted
   * workflow cannot suppress a different job in the same file that calls an untrusted one.
   */
  readonly matchNearest?: string
  /** How far back matchNearest may look, in lines. Default 20. */
  readonly within?: number
  /** Why. Printed in the log so a suppression is never invisible. */
  readonly reason?: string
}

export const DEFAULT_WITHIN = 20

/** Reads a file's lines, so suppression stays a pure function of its inputs. */
export type LineReader = (path: string) => string[]

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

/**
 * The text `match` is tested against: the finding's own snippet, or the nearest preceding line
 * matching `matchNearest`. Returns null when an anchor was required but not found within range,
 * which means "do not suppress" — the safe direction.
 */
export function subjectFor(result: OpengrepResult, rule: IgnoreRule, readLines?: LineReader): string | null {
  if (!rule.matchNearest) {
    // extra.lines is the matched source. Empty string for a finding with no snippet means it is
    // never suppressed, which is again the safe direction.
    return result.extra?.lines ?? ''
  }
  if (!readLines) return null

  let anchor: RegExp
  try {
    anchor = new RegExp(rule.matchNearest)
  } catch (error) {
    throw new Error(`Invalid 'match-nearest' regular expression for rule '${rule.rule}': ${(error as Error).message}`)
  }

  const lines = readLines(result.path)
  const within = rule.within ?? DEFAULT_WITHIN
  // start.line is 1-based; step back from the line before the finding.
  const from = result.start.line - 2
  for (let i = from; i >= 0 && i > from - within; i--) {
    const line = lines[i]
    if (line != null && anchor.test(line)) return line
  }
  return null
}

export function isSuppressed(
  result: OpengrepResult,
  rule: IgnoreRule,
  pattern: RegExp,
  readLines?: LineReader
): boolean {
  if (!result.check_id?.includes(rule.rule)) return false
  const subject = subjectFor(result, rule, readLines)
  return subject != null && pattern.test(subject)
}

/**
 * Drop findings matching any ignore rule, and report how many each one removed.
 *
 * The counts matter: a suppression that silently stops matching (the rule id changed upstream, the
 * pattern no longer fits) should be visible as a zero, not discovered months later.
 */
export function applySuppressions(
  report: OpengrepReport,
  rules: IgnoreRule[],
  readLines?: LineReader
): SuppressionResult {
  if (rules.length === 0) return { report, suppressions: [], total: 0 }

  const patterns = rules.map(rule => ({ rule, pattern: matcher(rule) }))
  const counts = new Map<IgnoreRule, number>(rules.map(rule => [rule, 0]))

  const kept = (report.results ?? []).filter(result => {
    const hit = patterns.find(({ rule, pattern }) => isSuppressed(result, rule, pattern, readLines))
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
  const where = rule.matchNearest ? ` near /${rule.matchNearest}/` : ''
  return `${count} finding(s) matching /${rule.match}/${where} in ${rule.rule}${reason}`
}
