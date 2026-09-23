import * as core from '@actions/core'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/**
 * The shape of `.opengrep/settings.yml`.
 *
 * Every key maps onto an opengrep flag, so the scan is reproducible by hand. Nothing here is
 * post-processed by the action: a finding this file does not silence is a finding opengrep itself
 * reported.
 *
 * Deliberately absent: severity, mode and fail-on-severity. Those describe how a *workflow* runs
 * the scan, not what the repository considers a finding, so they stay action inputs.
 */
export interface OpengrepConfig {
  /** Registry packs. A bare word is shorthand: `java` means `p/java`. */
  rulesets?: string[]
  /** Full dotted rule ids to drop, as --exclude-rule. */
  'exclude-rules'?: string[]
  /** Globs to skip, as --exclude. */
  'exclude-paths'?: string[]
  /** Repository rules, inline. Written to a file and passed as an extra --config. */
  rules?: unknown[]
}

export interface Settings {
  readonly rulesets: string
  readonly excludeRules: string[]
  readonly excludePaths: string[]
  readonly rules: unknown[]
}

export const CONFIG_FILENAMES = ['settings.yml', 'settings.yaml'] as const

export function parseConfig(source: string): OpengrepConfig {
  const parsed = parseYaml(source) as unknown
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenGrep settings must be a YAML mapping.')
  }
  return parsed as OpengrepConfig
}

function asList(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.map(String).map(entry => entry.trim()).filter(Boolean) : []
}

/**
 * --exclude-rule matches the whole id, so a short name silently does nothing: excluding
 * `github-actions-mutable-action-tag` leaves every one of its findings in place, while
 * `yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag`
 * works. Registry ids are always dotted, so a dot-less entry is the tell.
 */
export function shortRuleIds(excludeRules: string[]): string[] {
  return excludeRules.filter(id => !id.includes('.'))
}

export function resolveSettings(config: OpengrepConfig): Settings {
  const rulesets = asList(config.rulesets)
  const rules = Array.isArray(config.rules) ? config.rules : []
  if (rulesets.length === 0 && rules.length === 0) {
    throw new Error("OpenGrep settings must set 'rulesets' or 'rules'; the action ships no default.")
  }

  return {
    rulesets: rulesets.join(','),
    excludeRules: [...new Set(asList(config['exclude-rules']))],
    excludePaths: [...new Set(asList(config['exclude-paths']))],
    rules
  }
}

/**
 * The repository root of kestra-io/actions as checked out by the runner.
 *
 * The bundle lives at <root>/actions/scan-opengrep/dist/index.js, so the root is three levels up.
 * Reading the fallback off disk rather than fetching it keeps the scan working without network
 * access to raw.githubusercontent.com, and guarantees the settings match the action version in use.
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
 * Load the scanned repository's settings, falling back to the one shipped in kestra-io/actions.
 *
 * The fallback is a real settings file rather than values baked into the code: a repository that
 * wants to see what it is being scanned with reads that file, and can copy it as the starting point
 * for its own.
 */
export async function loadConfig(configDir: string, fallbackDir: string): Promise<LoadedConfig> {
  const own = await readFirst(configDir)
  if (own) {
    core.info(`Settings: ${own.file}`)
    return { config: parseConfig(own.text), source: own.file, fromFallback: false }
  }

  const fallback = await readFirst(fallbackDir)
  if (fallback) {
    core.info(`Settings: none in ${configDir}, using the kestra-io/actions default (${fallback.file})`)
    return { config: parseConfig(fallback.text), source: fallback.file, fromFallback: true }
  }

  throw new Error(
    `No OpenGrep settings found in '${configDir}' or in the action's own '${fallbackDir}'. ` +
      'The action ships no defaults; add .opengrep/settings.yml.'
  )
}
