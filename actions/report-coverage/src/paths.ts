import * as path from 'node:path'

/**
 * Turns whatever a coverage report calls a file into a POSIX path relative to the repository root.
 * Every producer writes its own flavour: an absolute runner path, a `./` prefix, backslashes on a
 * report built on Windows, or a path already relative to the checkout. Whichever it is, this is the
 * one shape `file.path` and every downstream lookup (module detection, the source link) can rely on.
 */
export function toRepoPath(raw: string, workspace: string | undefined): string | undefined {
  if (!raw) return undefined
  let normalized = raw.replace(/\\/g, '/').trim()
  if (!normalized) return undefined

  if (workspace) {
    const base = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized === base) return undefined
    if (normalized.startsWith(`${base}/`)) normalized = normalized.slice(base.length + 1)
  }

  // An absolute path outside the workspace points at nothing checked out in this run — a vendored
  // or generated file a report includes that the repository itself does not track.
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) return undefined

  const collapsed = path.posix.normalize(normalized).replace(/^\.\//, '')
  if (collapsed === '.' || collapsed.startsWith('../')) return undefined
  return collapsed
}

/**
 * Cobertura's `filename` is relative to one of the `<sources>` entries, and which one is not
 * recorded per class — so every source is tried, and the first one that resolves to an existing
 * kind of path (relative, no `..`) wins. When no source matches, the filename is tried as-is: some
 * producers already write repo-relative paths there.
 */
export function resolveCoberturaPath(filename: string, sources: string[], workspace: string | undefined): string | undefined {
  for (const source of sources) {
    const joined = path.posix.join(source.replace(/\\/g, '/'), filename.replace(/\\/g, '/'))
    const resolved = toRepoPath(joined, workspace)
    if (resolved) return resolved
  }
  return toRepoPath(filename, workspace)
}
