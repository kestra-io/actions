import { toRepoPath } from './paths.js'
import type { FileCoverage } from './model.js'

/**
 * LCOV's own trace format — one record per source file, terminated by `end_of_record`. Written by
 * every JS/TS coverage tool (vitest, jest, istanbul/nyc, c8) and by many others (Python's coverage.py
 * with the lcov plugin, Go via gcov2lcov). Only the summary counters are read (LF/LH/BRF/BRH/FNF/FNH);
 * per-line hit counts (DA:) are not needed for a file/module rollup.
 */
export function parseLcov(content: string, workspace: string | undefined): FileCoverage[] {
  const files: FileCoverage[] = []
  let path: string | undefined
  let lf = 0, lh = 0, brf = 0, brh = 0, fnf = 0, fnh = 0

  const flush = (): void => {
    if (path) {
      files.push({
        path,
        format: 'lcov',
        lines: { covered: lh, missed: Math.max(lf - lh, 0) },
        branches: brf > 0 ? { covered: brh, missed: Math.max(brf - brh, 0) } : undefined,
        functions: fnf > 0 ? { covered: fnh, missed: Math.max(fnf - fnh, 0) } : undefined
      })
    }
    path = undefined
    lf = lh = brf = brh = fnf = fnh = 0
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const separator = line.indexOf(':')
    const key = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1)

    switch (key) {
      case 'SF':
        path = toRepoPath(value, workspace)
        break
      case 'LF':
        lf = Number(value) || 0
        break
      case 'LH':
        lh = Number(value) || 0
        break
      case 'BRF':
        brf = Number(value) || 0
        break
      case 'BRH':
        brh = Number(value) || 0
        break
      case 'FNF':
        fnf = Number(value) || 0
        break
      case 'FNH':
        fnh = Number(value) || 0
        break
      case 'end_of_record':
        flush()
        break
    }
  }
  // A trace missing its terminator still has data worth keeping.
  flush()

  return files
}
