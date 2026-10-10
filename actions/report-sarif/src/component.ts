import * as path from 'node:path'

export interface ComponentRule {
  readonly component: string
  readonly glob: string
}

/**
 * Newline separated `component=glob` pairs, kept in order since the first match wins. Not
 * parsePairs: that keys on the component, and one component often owns several globs.
 */
export function parseComponents(raw: string): ComponentRule[] {
  const rules: ComponentRule[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const component = trimmed.slice(0, separator).trim()
    const glob = trimmed.slice(separator + 1).trim()
    if (component && glob) rules.push({ component, glob })
  }
  return rules
}

/**
 * The component owning a repository relative path, so a single scan of a repository holding both
 * the backend and the frontend labels each finding with the right one. Undefined when the finding
 * has no file (a Trivy target is an ecosystem, not a path) or no rule matches.
 */
export function componentOf(file: string | undefined, rules: ComponentRule[]): string | undefined {
  if (!file) return undefined
  const relative = file.replace(/^file:\/\//, '').replace(/^\.\//, '')
  return rules.find(rule => path.matchesGlob(relative, rule.glob))?.component
}
