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
 * Values reaching argv come from .opengrep/config.yml, which any repository can edit.
 *
 * exec.exec spawns without a shell, so there is no command injection to have here — but a value
 * beginning with `-` is still read by opengrep as a flag rather than as data, which would let a
 * config file smuggle in scanner options it was never meant to set. Rejecting the leading dash
 * closes that without needing to know opengrep's whole flag surface.
 */
export function assertNotFlag(value: string, field: string): string {
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${field} '${value}': values starting with '-' would be read as an OpenGrep flag.`)
  }
  return value
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
  for (const config of ruleset.configs) args.push('--config', assertNotFlag(config, 'ruleset'))
  args.push(`--json-output=${jsonOutput}`)
  args.push(`--sarif-output=${sarifOutput}`)
  for (const severity of severities) args.push('--severity', severity)
  for (const rule of options.excludeRules ?? []) args.push('--exclude-rule', assertNotFlag(rule, 'exclude-rules entry'))
  for (const pattern of options.excludePaths ?? []) args.push('--exclude', assertNotFlag(pattern, 'exclude-paths entry'))
  if (baseline) args.push('--baseline-commit', baseline)
  args.push('--no-error', '--quiet', assertNotFlag(scanPath, 'scan-path'))

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
