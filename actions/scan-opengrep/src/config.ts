import { parse as parseYaml } from 'yaml'
import type { IgnoreRule } from './suppress.js'
import { DEFAULT_EXCLUDED_PATHS, DEFAULT_IGNORED_FINDINGS, DEFAULT_RULESETS } from './version.js'

/**
 * The shape of `.opengrep/config.yml` in the repository being scanned.
 *
 * Configuration lives with the code it governs rather than in the calling workflow: a plugin
 * repository that needs a different ruleset, or needs to silence a rule, changes one file it owns
 * instead of threading another input through a workflow shared by 239 repositories.
 */
export interface OpengrepConfig {
  rulesets?: string[]
  'exclude-rules'?: string[]
  'ignore-findings'?: (IgnoreRule & { 'match-nearest'?: string })[]
  'exclude-paths'?: string[]
  mode?: string
  severity?: string[]
  'fail-on-severity'?: string
}

export interface Settings {
  readonly rulesets: string
  readonly excludeRules: string[]
  readonly ignoreFindings: IgnoreRule[]
  readonly excludePaths: string[]
  readonly mode: string
  readonly severity: string
  readonly failOnSeverity: string
}

/** Action inputs, used wherever the config file is silent. */
export interface Inputs {
  readonly rulesets: string
  readonly mode: string
  readonly severity: string
  readonly failOnSeverity: string
}

export function parseConfig(source: string): OpengrepConfig {
  const parsed = parseYaml(source) as unknown
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.opengrep/config.yml must be a YAML mapping.')
  }
  return parsed as OpengrepConfig
}

function asList(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.map(String).map(entry => entry.trim()).filter(Boolean) : []
}

/**
 * Two identical suppressions are one suppression. Repeating an org-wide default in a repository
 * config is a natural thing to do for documentation, and without this it logs the same rule twice —
 * once with the real count and once with a misleading zero.
 */
function dedupeIgnoreRules(rules: IgnoreRule[]): IgnoreRule[] {
  const seen = new Set<string>()
  return rules.filter(rule => {
    const key = `${rule.rule}\u0000${rule.match}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normaliseIgnoreRules(value: IgnoreRule[] | undefined): IgnoreRule[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => {
    if (!entry?.rule || !entry?.match) {
      throw new Error(`ignore-findings[${index}] needs both a 'rule' and a 'match'.`)
    }
    const raw = entry as IgnoreRule & { 'match-nearest'?: string }
    const matchNearest = raw.matchNearest ?? raw['match-nearest']
    return {
      rule: String(entry.rule),
      match: String(entry.match),
      ...(matchNearest ? { matchNearest: String(matchNearest) } : {}),
      ...(entry.within != null ? { within: Number(entry.within) } : {}),
      reason: entry.reason
    }
  })
}

/**
 * Merge the config file over the action inputs.
 *
 * The split is deliberate. The config file owns *what to look for and how hard to fail* — rulesets,
 * exclusions, severity, the gate — because those are repository-wide policy. The workflow keeps
 * `scan-path`, because that is per job: a repository with a backend and a frontend job scans `.` in
 * one and `ui` in the other, and a single file at the repository root cannot express both.
 *
 * The file wins on every key it does set, because it is the thing a repository owner can edit. The
 * exception is ignore-findings, which is additive: DEFAULT_IGNORED_FINDINGS carries org-wide
 * decisions that a repository should not silently lose by declaring a suppression of its own.
 */
export function resolveSettings(config: OpengrepConfig, inputs: Inputs): Settings {
  const rulesets = asList(config.rulesets)
  const severity = asList(config.severity)

  return {
    rulesets: rulesets.length > 0 ? rulesets.join(',') : inputs.rulesets || DEFAULT_RULESETS,
    excludeRules: [...new Set(asList(config['exclude-rules']))],
    ignoreFindings: dedupeIgnoreRules([...DEFAULT_IGNORED_FINDINGS, ...normaliseIgnoreRules(config['ignore-findings'])]),
    excludePaths: [...new Set([...DEFAULT_EXCLUDED_PATHS, ...asList(config['exclude-paths'])])],
    mode: config.mode ?? inputs.mode,
    severity: severity.length > 0 ? severity.join(',') : inputs.severity,
    failOnSeverity: config['fail-on-severity'] ?? inputs.failOnSeverity
  }
}
