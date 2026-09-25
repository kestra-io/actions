/** The coverage report formats this action reads. */
export type CoverageFormat = 'jacoco' | 'cobertura' | 'lcov'

/** Covered/missed pair a counter reports, whatever it counts. */
export interface Counter {
  readonly covered: number
  readonly missed: number
}

/**
 * Coverage for one source file, before it is assigned a module. `path` is repo-relative POSIX,
 * the shape every downstream step (module detection, documents, the summary) keys on.
 */
export interface FileCoverage {
  readonly path: string
  readonly format: CoverageFormat
  readonly lines: Counter
  readonly branches?: Counter
  readonly functions?: Counter
}

export function total(counter: Counter): number {
  return counter.covered + counter.missed
}

/** Percentage covered, 0 when there is nothing to cover — never NaN. */
export function pct(counter: Counter): number {
  const denominator = total(counter)
  return denominator === 0 ? 0 : Math.round((counter.covered / denominator) * 10000) / 100
}

export function addCounter(a: Counter, b: Counter): Counter {
  return { covered: a.covered + b.covered, missed: a.missed + b.missed }
}

/**
 * Combines coverage for the same file reported twice (two reports, or a report split across
 * modules), keeping the more complete counter rather than adding them — adding would double count
 * a line both reports agree was hit.
 */
export function mergeCounter(a: Counter | undefined, b: Counter | undefined): Counter | undefined {
  if (!a) return b
  if (!b) return a
  return {
    covered: Math.max(a.covered, b.covered),
    missed: Math.max(total(a), total(b)) - Math.max(a.covered, b.covered)
  }
}
