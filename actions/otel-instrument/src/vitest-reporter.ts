import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { stepSpanId } from '../../../shared/otel-core/src/ids.js'

/**
 * Vitest reporter emitting a span per run, per test file and per test.
 *
 * It is loaded by Vitest through Vite's module runner, so it must stay free of
 * npm dependencies (bundled to dist/vitest-reporter.js with node builtins only).
 * It does not export anything itself: it writes span records to
 * $OTEL_VITEST_SPANS_DIR and the action's post hook exports them over gRPC.
 */

export const VITEST_SPANS_DIR_ENV = 'OTEL_VITEST_SPANS_DIR'

export interface VitestSpanRecord {
  name: string
  spanId: string
  parentSpanId: string
  startMs: number
  endMs: number
  conclusion: 'success' | 'failure' | 'skipped' | null
  attributes: Record<string, string | number | boolean>
}

export interface VitestSpanFile {
  traceId: string
  spans: VitestSpanRecord[]
}

// Structural subset of Vitest's reporter API (v3+), so this file needs no vitest dependency.
interface TestCaseLike {
  fullName: string
  result(): { state: string; errors?: ReadonlyArray<{ message?: string }> }
  diagnostic(): { startTime: number; duration: number; retryCount: number; flaky: boolean } | undefined
}

interface TestModuleLike {
  moduleId: string
  relativeModuleId?: string
  project: { name: string }
  state(): string
  children: { allTests(): Iterable<TestCaseLike> }
}

const newSpanId = (): string => randomBytes(8).toString('hex')

/**
 * Parent of the run span: the step named by OTEL_STEP_NAME when set (its span id is
 * deterministic, see ids.ts), else whatever TRACEPARENT points at (job or parent-step-name).
 */
export function resolveParent(env: NodeJS.ProcessEnv): { traceId: string; spanId: string } | null {
  if (env.OTEL_STEP_NAME && env.OTEL_JOB_ID && env.OTEL_TRACE_ID) {
    return { traceId: env.OTEL_TRACE_ID, spanId: stepSpanId(env.OTEL_JOB_ID, env.OTEL_STEP_NAME) }
  }
  const parts = (env.TRACEPARENT ?? '').split('-')
  if (parts.length >= 3 && parts[0] === '00') return { traceId: parts[1], spanId: parts[2] }
  return null
}

function conclusionOf(state: string): VitestSpanRecord['conclusion'] {
  if (state === 'passed') return 'success'
  if (state === 'failed') return 'failure'
  if (state === 'skipped') return 'skipped'
  return null
}

export default class OtelVitestReporter {
  private runStart = Date.now()
  private moduleTimes = new Map<string, { start: number; end?: number }>()

  onTestRunStart(): void {
    this.runStart = Date.now()
  }

  onTestModuleStart(module: TestModuleLike): void {
    this.moduleTimes.set(module.moduleId, { start: Date.now() })
  }

  onTestModuleEnd(module: TestModuleLike): void {
    const times = this.moduleTimes.get(module.moduleId)
    if (times) times.end = Date.now()
  }

  onTestRunEnd(modules: ReadonlyArray<TestModuleLike>, _errors: unknown, reason: string): void {
    const dir = process.env[VITEST_SPANS_DIR_ENV]
    const parent = resolveParent(process.env)
    if (!dir || !parent) return

    const runEnd = Date.now()
    const runSpanId = newSpanId()
    const projects = [...new Set(modules.map((m) => m.project.name).filter(Boolean))]
    const spans: VitestSpanRecord[] = [
      {
        name: projects.length ? `vitest ${projects.join(' ')}` : 'vitest',
        spanId: runSpanId,
        parentSpanId: parent.spanId,
        startMs: this.runStart,
        endMs: runEnd,
        conclusion: reason === 'failed' ? 'failure' : reason === 'passed' ? 'success' : null,
        attributes: { 'telemetry.source': 'vitest', 'vitest.run.reason': reason }
      }
    ]

    for (const module of modules) {
      const file = module.relativeModuleId ?? module.moduleId
      const times = this.moduleTimes.get(module.moduleId)
      const moduleSpanId = newSpanId()
      spans.push({
        name: file,
        spanId: moduleSpanId,
        parentSpanId: runSpanId,
        startMs: times?.start ?? this.runStart,
        endMs: times?.end ?? runEnd,
        conclusion: conclusionOf(module.state()),
        attributes: { 'telemetry.source': 'vitest', 'test.project': module.project.name, 'test.file': file }
      })

      for (const test of module.children.allTests()) {
        const diagnostic = test.diagnostic()
        if (!diagnostic) continue
        const result = test.result()
        const attributes: VitestSpanRecord['attributes'] = {
          'telemetry.source': 'vitest',
          'test.project': module.project.name,
          'test.file': file,
          'test.name': test.fullName,
          'test.result': result.state,
          'test.retry_count': diagnostic.retryCount,
          'test.flaky': diagnostic.flaky
        }
        const error = result.errors?.[0]?.message
        if (error) attributes['test.error'] = error.slice(0, 4096)
        spans.push({
          name: `${file} > ${test.fullName}`,
          spanId: newSpanId(),
          parentSpanId: moduleSpanId,
          startMs: diagnostic.startTime,
          endMs: diagnostic.startTime + diagnostic.duration,
          conclusion: conclusionOf(result.state),
          attributes
        })
      }
    }

    const record: VitestSpanFile = { traceId: parent.traceId, spans }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `vitest-${process.pid}-${runEnd}.json`), JSON.stringify(record))
  }
}
