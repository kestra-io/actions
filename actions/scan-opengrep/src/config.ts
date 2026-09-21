import * as core from '@actions/core'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { IgnoreRule } from './suppress.js'

/**
 * The shape of `.opengrep/config.yml`.
 *
 * This file is the only source of scan behaviour. The action holds no defaults for rulesets,
 * severities, exclusions, suppressions or the gate — so running opengrep by hand with the values in
 * this file reproduces exactly what CI does, and a setting cannot come from somewhere unreadable.
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

export const CONFIG_FILENAMES = ['config.yml', 'config.yaml'] as const

export function parseConfig(source: string): OpengrepConfig {
  const parsed = parseYaml(source) as unknown
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenGrep config must be a YAML mapping.')
  }
  return parsed as OpengrepConfig
}

function asList(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.map(String).map(entry => entry.trim()).filter(Boolean) : []
}

/**
 * Two identical suppressions are one suppression. Without this, a config file listing the same rule
 * twice logs it twice — once with the real count and once with a misleading zero, which reads as a
 * suppression that stopped working.
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

function normaliseIgnoreRules(value: OpengrepConfig['ignore-findings']): IgnoreRule[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => {
    if (!entry?.rule || !entry?.match) {
      throw new Error(`ignore-findings[${index}] needs both a 'rule' and a 'match'.`)
    }
    const matchNearest = entry.matchNearest ?? entry['match-nearest']
    return {
      rule: String(entry.rule),
      match: String(entry.match),
      ...(matchNearest ? { matchNearest: String(matchNearest) } : {}),
      ...(entry.within != null ? { within: Number(entry.within) } : {}),
      reason: entry.reason
    }
  })
}

export function resolveSettings(config: OpengrepConfig): Settings {
  const rulesets = asList(config.rulesets)
  if (rulesets.length === 0) {
    throw new Error("OpenGrep config must set 'rulesets'; the action ships no default.")
  }
  const severity = asList(config.severity)
  if (severity.length === 0) {
    throw new Error("OpenGrep config must set 'severity'; the action ships no default.")
  }
  if (!config['fail-on-severity']) {
    throw new Error("OpenGrep config must set 'fail-on-severity'; the action ships no default.")
  }
  if (!config.mode) {
    throw new Error("OpenGrep config must set 'mode'; the action ships no default.")
  }

  return {
    rulesets: rulesets.join(','),
    excludeRules: [...new Set(asList(config['exclude-rules']))],
    ignoreFindings: dedupeIgnoreRules(normaliseIgnoreRules(config['ignore-findings'])),
    excludePaths: [...new Set(asList(config['exclude-paths']))],
    mode: config.mode,
    severity: severity.join(','),
    failOnSeverity: config['fail-on-severity']
  }
}

/**
 * The repository root of kestra-io/actions as checked out by the runner.
 *
 * The bundle lives at <root>/actions/scan-opengrep/dist/index.js, so the root is three levels up.
 * Reading the fallback off disk rather than fetching it keeps the scan working without network
 * access to raw.githubusercontent.com, and guarantees the config matches the action version in use.
 */
export function actionRepoRoot(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..', '..')
}

export interface LoadedConfig {
  readonly config: OpengrepConfig
  readonly source: string
  readonly fromFallback: boolean
}

async function readFirst(dir: string): Promise<{ text: string; file: string } | null> {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(dir, name)
    try {
      return { text: await fs.readFile(file, 'utf8'), file }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Load the scanned repository's config, falling back to the one shipped in kestra-io/actions.
 *
 * The fallback is a real config file rather than values baked into the code: a repository that
 * wants to see what it is being scanned with reads that file, and can copy it as the starting point
 * for its own.
 */
export async function loadConfig(configDir: string, fallbackDir: string): Promise<LoadedConfig> {
  const own = await readFirst(configDir)
  if (own) {
    core.info(`Configuration: ${own.file}`)
    return { config: parseConfig(own.text), source: own.file, fromFallback: false }
  }

  const fallback = await readFirst(fallbackDir)
  if (fallback) {
    core.info(`Configuration: none in ${configDir}, using the kestra-io/actions default (${fallback.file})`)
    return { config: parseConfig(fallback.text), source: fallback.file, fromFallback: true }
  }

  throw new Error(
    `No OpenGrep configuration found in '${configDir}' or in the action's own '${fallbackDir}'. ` +
      'The action ships no defaults; add .opengrep/config.yml.'
  )
}
