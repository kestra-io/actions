import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'

const FILE_MARKERS = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']

export interface ModuleDetector {
  readonly exists: (file: string) => boolean
  readonly list: (dir: string) => string[]
}

const DEFAULT_DETECTOR: ModuleDetector = {
  exists: existsSync,
  list: (dir: string) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
}

function hasBuildFile(absoluteDir: string, detector: ModuleDetector): boolean {
  if (FILE_MARKERS.some(marker => detector.exists(path.join(absoluteDir, marker)))) return true
  return detector.list(absoluteDir).some(entry => entry.endsWith('.csproj'))
}

/**
 * Which module a repo-relative file belongs to, for a monorepo dashboard to group and filter by.
 * `overrides` — the `modules` input — wins when its prefix matches, since a caller who set one knows
 * their own layout better than a heuristic. Otherwise the closest ancestor directory carrying a build
 * file wins: the root of a Gradle module, a Maven module, an npm workspace package, a Python project,
 * a Go module or a Cargo crate. A file with no such ancestor belongs to the repository root, `.`.
 */
export function detectModule(
  repoPath: string,
  workspace: string,
  overrides: Record<string, string>,
  detector: ModuleDetector = DEFAULT_DETECTOR
): string {
  for (const [name, prefix] of Object.entries(overrides)) {
    const normalized = prefix.replace(/\/+$/, '')
    if (repoPath === normalized || repoPath.startsWith(`${normalized}/`)) return name
  }

  let dir = path.posix.dirname(repoPath)
  while (dir && dir !== '.') {
    if (hasBuildFile(path.join(workspace, dir), detector)) return dir
    const parent = path.posix.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '.'
}
