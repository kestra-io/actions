import { XMLParser } from 'fast-xml-parser'
import { resolveCoberturaPath } from './paths.js'
import type { Counter, FileCoverage } from './model.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: name => ['source', 'package', 'class', 'line'].includes(name) })

interface CoberturaLine {
  '@_hits'?: string
  '@_branch'?: string
  '@_condition-coverage'?: string
}

interface CoberturaClass {
  '@_filename'?: string
  lines?: { line?: CoberturaLine[] }
}

interface CoberturaPackage {
  classes?: { class?: CoberturaClass[] }
}

interface CoberturaDoc {
  coverage?: {
    sources?: { source?: string[] }
    packages?: { package?: CoberturaPackage[] }
  }
}

function branchCounter(lines: CoberturaLine[]): Counter | undefined {
  const branchLines = lines.filter(line => line['@_branch'] === 'true')
  if (branchLines.length === 0) return undefined
  let covered = 0, total = 0
  for (const line of branchLines) {
    // "50% (1/2)" - the fraction covered/total branches taken at that line.
    const match = /\((\d+)\/(\d+)\)/.exec(line['@_condition-coverage'] ?? '')
    if (!match) continue
    covered += Number(match[1])
    total += Number(match[2])
  }
  return total > 0 ? { covered, missed: total - covered } : undefined
}

/**
 * Cobertura XML — the de facto standard outside the JVM: coverage.py (`coverage xml`), pytest-cov,
 * Go's gocover-cobertura, .NET's coverlet, PHP's phpunit --coverage-cobertura all emit this shape.
 * One `<class>` per source file (not per language class — a Python module is one `<class>` too),
 * grouped under `<package>`, each `<line>` a source line with its hit count.
 */
export function parseCobertura(content: string, workspace: string | undefined): FileCoverage[] {
  const doc = parser.parse(content) as CoberturaDoc
  const coverage = doc.coverage
  if (!coverage) return []

  const sources = coverage.sources?.source ?? []
  const files: FileCoverage[] = []

  for (const pkg of coverage.packages?.package ?? []) {
    for (const cls of pkg.classes?.class ?? []) {
      const filename = cls['@_filename']
      if (!filename) continue
      const path = resolveCoberturaPath(filename, sources, workspace)
      if (!path) continue

      const lines = cls.lines?.line ?? []
      let covered = 0, missed = 0
      for (const line of lines) {
        if (Number(line['@_hits'] ?? 0) > 0) covered++
        else missed++
      }

      files.push({ path, format: 'cobertura', lines: { covered, missed }, branches: branchCounter(lines) })
    }
  }

  return files
}
