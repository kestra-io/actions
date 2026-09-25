import { addCounter } from './model.js'
import type { Counter, FileCoverage } from './model.js'

export interface ModuleTotals {
  lines: Counter
  branches?: Counter
  functions?: Counter
}

/** Built from the file-level documents; both the baseline artifact and the PR comment read this. */
export interface CoverageSummary {
  readonly repository: string
  readonly component: string
  readonly sha: string
  readonly runId: string
  readonly modules: Record<string, ModuleTotals>
  readonly totals: ModuleTotals
}

function add(a: ModuleTotals, file: FileCoverage): ModuleTotals {
  return {
    lines: addCounter(a.lines, file.lines),
    branches: file.branches ? addCounter(a.branches ?? { covered: 0, missed: 0 }, file.branches) : a.branches,
    functions: file.functions ? addCounter(a.functions ?? { covered: 0, missed: 0 }, file.functions) : a.functions
  }
}

const EMPTY: ModuleTotals = { lines: { covered: 0, missed: 0 } }

export function buildSummary(
  files: readonly (FileCoverage & { readonly module: string })[],
  context: { readonly repository: string; readonly component: string; readonly sha: string; readonly runId: string }
): CoverageSummary {
  const modules: Record<string, ModuleTotals> = {}
  let totals: ModuleTotals = EMPTY

  for (const file of files) {
    modules[file.module] = add(modules[file.module] ?? EMPTY, file)
    totals = add(totals, file)
  }

  return { ...context, modules, totals }
}
