import type { CoverageFormat } from './model.js'

/**
 * Detected from content rather than extension: JaCoCo, Cobertura and a hand-written report can all
 * be named coverage.xml, and LCOV has no extension convention at all.
 */
export function detectFormat(content: string): CoverageFormat | undefined {
  const head = content.slice(0, 4096)
  if (/^\s*(TN:|SF:)/m.test(content)) return 'lcov'
  if (/<!DOCTYPE\s+report\s+SYSTEM\s+"report\.dtd"/i.test(head) || /<report\b[^>]*>[\s\S]*<sessioninfo\b/i.test(content)) return 'jacoco'
  if (/<coverage\b[^>]*\bline-rate=/.test(head)) return 'cobertura'
  // A JaCoCo report without the DTD line still has a <report> root with <package>/<sourcefile>
  // children, which Cobertura's <coverage> root never does.
  if (/<report\b/.test(head) && /<sourcefile\b/.test(content)) return 'jacoco'
  return undefined
}
