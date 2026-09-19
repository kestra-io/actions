import * as path from 'node:path'

export type Severity = 'ERROR' | 'WARNING' | 'INFO'

export interface OpengrepResult {
  check_id: string
  path: string
  start: { line: number; col?: number }
  end?: { line: number; col?: number }
  extra: { severity: Severity; message: string; lines?: string }
}

export interface OpengrepError {
  level?: string
  type?: unknown
  message?: string
}

export interface OpengrepReport {
  results?: OpengrepResult[]
  errors?: OpengrepError[]
  paths?: { scanned?: string[] }
}

export interface Summary {
  readonly ERROR: number
  readonly WARNING: number
  readonly INFO: number
  readonly total: number
  /** Files OpenGrep could only partially parse. Cosmetic: the scan still ran. */
  readonly parseErrors: number
  /** Errors that stopped rules loading or files being scanned. Never cosmetic. */
  readonly fatalErrors: number
  readonly filesScanned: number
}

/**
 * For rules loaded off disk, OpenGrep derives the rule id from the rule file's path, so a finding
 * from a repository-local .opengrep/ comes back as "opengrep.my-rule".
 *
 * Two prefixes are possible: the full dotted path when the rules live outside the scanned tree,
 * and just the containing directory when they live inside it. Strip whichever matches; if neither
 * does the id is already clean, which is the normal case for registry packs.
 *
 * `--no-rewrite-rule-ids` is not the answer here — it strips too much, reducing
 * `generic.secrets.security.detected-private-key` to a context-free `detected-private-key`.
 */
export function rulePrefixes(rulesRoot: string): string[] {
  // Registry packs arrive already clean (java.lang.security.audit.unsafe-reflection), so there is
  // no root and nothing to strip.
  if (!rulesRoot) return []
  const full = `${rulesRoot.replace(/^\//, '').replace(/\//g, '.')}.`
  const short = `${path.basename(rulesRoot).replace(/^\.+/, '')}.`
  return [full, short]
}

export function normaliseRuleId(ruleId: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (prefix.length > 1 && ruleId.startsWith(prefix)) return ruleId.slice(prefix.length)
  }
  return ruleId
}

export function normaliseReport(report: OpengrepReport, rulesRoot: string): OpengrepReport {
  const prefixes = rulePrefixes(rulesRoot)
  return {
    ...report,
    results: (report.results ?? []).map(result => ({
      ...result,
      check_id: normaliseRuleId(result.check_id, prefixes)
    }))
  }
}

/** SARIF carries rule ids in two places; both need the same treatment. */
export function normaliseSarif(sarif: any, rulesRoot: string): any {
  const prefixes = rulePrefixes(rulesRoot)
  for (const run of sarif?.runs ?? []) {
    for (const result of run?.results ?? []) {
      if (typeof result.ruleId === 'string') result.ruleId = normaliseRuleId(result.ruleId, prefixes)
    }
    for (const rule of run?.tool?.driver?.rules ?? []) {
      if (typeof rule.id === 'string') rule.id = normaliseRuleId(rule.id, prefixes)
    }
  }
  return sarif
}

/**
 * OpenGrep reports two very different things in the same `errors` array, and telling them apart is
 * the difference between "clean" and "did not run".
 *
 * A PartialParsing entry (level "warn") means one file parsed imperfectly — the scan happened. A
 * SemgrepError (level "error") means something like "Failed to download configuration from
 * https://semgrep.dev/p/... HTTP 404", which produces a report with zero results and zero files
 * scanned. Counting those together would let a registry outage render as a clean build.
 */
export function isFatal(error: OpengrepError): boolean {
  return error?.level === 'error'
}

export function summarise(report: OpengrepReport): Summary {
  const results = report.results ?? []
  const errors = report.errors ?? []
  const count = (severity: Severity): number => results.filter(r => r.extra?.severity === severity).length
  return {
    ERROR: count('ERROR'),
    WARNING: count('WARNING'),
    INFO: count('INFO'),
    total: results.length,
    parseErrors: errors.filter(error => !isFatal(error)).length,
    fatalErrors: errors.filter(isFatal).length,
    filesScanned: (report.paths?.scanned ?? []).length
  }
}

/**
 * True when the scan did not actually happen. Reporting "0 findings" for one of these is the worst
 * possible outcome: a green build that checked nothing.
 *
 * Keyed on fatal errors alone. Zero files scanned looks like the same thing but is not: asking for
 * p/javascript in a repository with no JavaScript legitimately matches nothing, and the cases that
 * really are broken — an unreachable ruleset, a scan path that does not exist — each produce a
 * fatal error of their own ("File not found: ...", "Failed to download configuration ...").
 */
export function scanDidNotRun(summary: Summary): boolean {
  return summary.fatalErrors > 0
}

/** Scanned nothing, but for a legitimate reason. Worth saying out loud, not worth alarming about. */
export function scannedNothing(summary: Summary): boolean {
  return summary.fatalErrors === 0 && summary.filesScanned === 0
}

/** The fatal messages, for an error the user can act on. */
export function fatalMessages(report: OpengrepReport): string[] {
  return (report.errors ?? [])
    .filter(isFatal)
    .map(error => error.message ?? 'unknown error')
}

export type FailOn = 'none' | 'WARNING' | 'ERROR'

/** How many findings are at or above the configured gate. `none` never blocks. */
export function blockingCount(summary: Summary, failOn: FailOn): number {
  switch (failOn) {
    case 'none':
      return 0
    case 'ERROR':
      return summary.ERROR
    case 'WARNING':
      return summary.ERROR + summary.WARNING
  }
}

export function parseFailOn(value: string): FailOn {
  if (value === 'none' || value === 'WARNING' || value === 'ERROR') return value
  throw new Error(`Unknown fail-on-severity '${value}'. Valid values: none, WARNING, ERROR`)
}
