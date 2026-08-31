import { createHash } from 'crypto'

/**
 * Deterministic trace/span ids, replicating the OpenTelemetry Collector
 * `githubreceiver` scheme byte-for-byte (sha256 hex, sliced). Both the live
 * build spans (which read the exported TRACEPARENT) and the post-hoc spans we
 * rebuild from the GitHub API must derive identical ids so they land in the
 * same trace tree.
 *
 *   trace id   sha256(`${run_id}${run_attempt}t`)[0:32]   (16 bytes)
 *   root span  sha256(`${run_id}${run_attempt}s`)[16:32]  ( 8 bytes)
 *   job span   sha256(`${job_id}-j`)[16:32]               ( 8 bytes)
 *   step span  sha256(`${job_id}-${step_name}-s`)[16:32]  ( 8 bytes)
 */

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function traceId(runId: string | number, runAttempt: string | number): string {
  return sha256hex(`${runId}${runAttempt}t`).slice(0, 32)
}

export function rootSpanId(runId: string | number, runAttempt: string | number): string {
  return sha256hex(`${runId}${runAttempt}s`).slice(16, 32)
}

export function jobSpanId(jobId: string | number): string {
  return sha256hex(`${jobId}-j`).slice(16, 32)
}

export function stepSpanId(jobId: string | number, stepName: string): string {
  return sha256hex(`${jobId}-${stepName}-s`).slice(16, 32)
}
