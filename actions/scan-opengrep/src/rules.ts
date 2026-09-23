import * as path from 'node:path'

/** A registry ref, a local file, or a local directory. Anything shell-hostile is rejected. */
const REF_PATTERN = /^[A-Za-z0-9._/@-]+$/

export interface ResolvedRulesets {
  readonly rulesets: string[]
}

/**
 * Parse the comma-separated rulesets setting into `--config` values.
 *
 * A bare word is sugar for a registry pack (`java` -> `p/java`); anything containing `/` or `.` is
 * passed through so a caller can still point at a local file or their own registry ref.
 */
export function resolveRulesets(input: string): ResolvedRulesets {
  const requested = input
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)

  const rulesets: string[] = []

  for (const entry of requested) {
    if (!REF_PATTERN.test(entry)) {
      throw new Error(`Invalid ruleset '${entry}'. Expected a registry pack like p/java, or a path to a rule file.`)
    }

    // A bare word is a pack name; a path keeps its shape.
    const ref = entry.includes('/') || entry.includes('.') ? entry : `p/${entry}`
    if (!rulesets.includes(ref)) rulesets.push(ref)
  }

  if (rulesets.length === 0) {
    throw new Error(`No OpenGrep rulesets resolved from rulesets='${input}'.`)
  }

  return { rulesets }
}

export interface Ruleset {
  /** One --config argument per entry. */
  readonly configs: string[]
  /** Directory rule ids are prefixed with, for rules loaded off disk. Empty when registry-only. */
  readonly root: string
  readonly source: 'registry' | 'registry+local' | 'local'
}

/**
 * Registry packs plus, when the settings file declares any, the repository's own rules.
 *
 * Local rules are additive: a repository that writes one rule of its own should not thereby lose
 * the registry ruleset. An empty rulesets list is how a repository opts out of the registry.
 *
 * `localRulesFile` must sit outside the scanned tree — RUNNER_TEMP, not the workspace. A path
 * beginning `p/` or `r/` is a registry reference to opengrep, not a file, so a rules file written
 * anywhere that could be read that way is silently fetched from semgrep.dev instead.
 */
export function buildRuleset(rulesets: string[], localRulesFile: string | null): Ruleset {
  const configs = [...rulesets]
  if (localRulesFile) configs.push(path.resolve(localRulesFile))

  const source = localRulesFile ? (rulesets.length > 0 ? 'registry+local' : 'local') : 'registry'
  return { configs, root: localRulesFile ? path.dirname(path.resolve(localRulesFile)) : '', source }
}
