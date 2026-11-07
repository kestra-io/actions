import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as core from '@actions/core'
import { buildResource, buildSpan, exportSpans, parseHeaders } from '../../../shared/otel-core/src/otlp.js'
import { VITEST_SPANS_DIR_ENV, type VitestSpanFile } from './vitest-reporter.js'

export const VITEST_REPORTER_ENV = 'OTEL_VITEST_REPORTER'
const EXPORT_BATCH = 1000

function spansDir(): string {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'otel-vitest-spans')
}

/**
 * Expose the reporter (bundled next to dist/index.js) so a step can add it with
 * `--reporter=$OTEL_VITEST_REPORTER`. Vitest has no env hook to add a reporter.
 */
export function installVitestReporter(): string {
  const reporterPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vitest-reporter.js')
  core.exportVariable(VITEST_REPORTER_ENV, reporterPath)
  core.exportVariable(VITEST_SPANS_DIR_ENV, spansDir())
  core.info(`Vitest reporter: ${reporterPath}`)
  return reporterPath
}

/** Export the span files written by the reporter during the job. */
export async function exportVitestSpans(
  serviceName: string,
  jobId: number | undefined,
  workflowName: string | undefined,
  endpoint: string,
  headers: string,
  dir: string = spansDir()
): Promise<number> {
  if (!fs.existsSync(dir)) return 0
  const resource = buildResource(`${serviceName} - Vitest`, jobId, undefined, undefined, workflowName)
  const spans = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const file = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as VitestSpanFile
      return file.spans.map((s) => buildSpan({ ...s, traceId: file.traceId }, resource))
    })
  for (let i = 0; i < spans.length; i += EXPORT_BATCH) {
    await exportSpans(spans.slice(i, i + EXPORT_BATCH), endpoint, parseHeaders(headers))
  }
  fs.rmSync(dir, { recursive: true, force: true })
  core.info(`Sent ${spans.length} Vitest spans`)
  return spans.length
}
