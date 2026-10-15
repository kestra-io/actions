import type { OpengrepResult, Severity } from './findings.js'

export type AnnotationLevel = 'notice' | 'warning' | 'failure'

export interface Annotation {
  path: string
  start_line: number
  end_line: number
  annotation_level: AnnotationLevel
  message: string
  title: string
  start_column?: number
  end_column?: number
}

/**
 * GitHub stops storing annotations past 1000 on a single check run, which is why these go to a check
 * run (published by comment-update) instead of `::warning` workflow commands, capped at 10 per step
 * and 50 per job — unusable for a full-tree scan.
 */
export const MAX_ANNOTATIONS = 1000

const LEVELS: Record<Severity, AnnotationLevel> = {
  ERROR: 'failure',
  WARNING: 'warning',
  INFO: 'notice'
}

export function toAnnotation(result: OpengrepResult): Annotation {
  const startLine = result.start.line
  // GitHub rejects an end_line before start_line, and only honours columns on single-line
  // annotations; a multi-line finding that kept them renders nothing at all.
  const endLine = Math.max(startLine, result.end?.line ?? startLine)
  const annotation: Annotation = {
    path: result.path,
    start_line: startLine,
    end_line: endLine,
    annotation_level: LEVELS[result.extra.severity] ?? 'warning',
    message: result.extra.message,
    title: result.check_id
  }

  if (startLine === endLine && result.start.col != null && result.end?.col != null) {
    annotation.start_column = result.start.col
    annotation.end_column = result.end.col
  }

  return annotation
}

export function toAnnotations(results: OpengrepResult[], max = MAX_ANNOTATIONS): Annotation[] {
  return results.slice(0, max).map(toAnnotation)
}
