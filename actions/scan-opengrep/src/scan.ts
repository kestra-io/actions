import type { Ruleset } from './rules.js'

export type Mode = 'auto' | 'diff' | 'full'
export type ResolvedMode = 'diff' | 'full'

export function parseMode(value: string): Mode {
  if (value === 'auto' || value === 'diff' || value === 'full') return value
  throw new Error(`Unknown OpenGrep mode '${value}'. Valid values: auto, diff, full`)
}

export function resolveMode(mode: Mode, eventName: string): ResolvedMode {
  if (mode === 'auto') return eventName === 'pull_request' ? 'diff' : 'full'
  return mode
}

export interface ScanArgsOptions {
  readonly ruleset: Ruleset
  readonly scanPath: string
  readonly severities: string[]
  readonly jsonOutput: string
  readonly sarifOutput: string
  readonly baseline?: string
  readonly excludeRules?: string[]
  readonly excludePaths?: string[]
}

/**
 * Builds the argv for `opengrep scan`.
 *
 * Deliberately `scan` and not `ci`: `ci` derives its baseline from a Semgrep AppSec Platform token
 * we do not have, and under GitHub Actions it completes without writing its output file at all
 * (opengrep#507, still open). `--baseline-commit` gives the same "only what this pull request
 * introduced" behaviour with no platform dependency.
 *
 * `--no-error` keeps the exit code clean so the report is always written and published; whether
 * findings fail the build is decided by the gate, not by opengrep.
 */
export function buildScanArgs(options: ScanArgsOptions): string[] {
  const { ruleset, scanPath, severities, jsonOutput, sarifOutput, baseline } = options

  const args = ['scan']
  for (const config of ruleset.configs) args.push('--config', config)
  args.push(`--json-output=${jsonOutput}`)
  args.push(`--sarif-output=${sarifOutput}`)
  for (const severity of severities) args.push('--severity', severity)
  for (const rule of options.excludeRules ?? []) args.push('--exclude-rule', rule)
  for (const pattern of options.excludePaths ?? []) args.push('--exclude', pattern)
  if (baseline) args.push('--baseline-commit', baseline)
  args.push('--no-error', '--quiet', scanPath)

  return args
}

export function parseSeverities(input: string): string[] {
  const allowed = ['ERROR', 'WARNING', 'INFO']
  const severities = input
    .split(',')
    .map(entry => entry.trim().toUpperCase())
    .filter(entry => entry.length > 0)

  for (const severity of severities) {
    if (!allowed.includes(severity)) {
      throw new Error(`Unknown severity '${severity}'. Valid values: ${allowed.join(', ')}`)
    }
  }
  if (severities.length === 0) throw new Error(`No severities resolved from severity='${input}'.`)
  return severities
}
