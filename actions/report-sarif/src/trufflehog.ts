/**
 * TruffleHog's `--json` output: one JSON object per line, one line per detected secret.
 *
 * The secret itself (`Raw`, `RawV2`, `Redacted`, `ExtraData`) is never copied into a finding. A
 * finding says which detector fired and where, which is all someone needs to rotate it, and
 * shipping the value would turn the security index into the leak.
 *
 * Why not `trufflehog --sarif`, which the generic SARIF reader would take as is: SARIF only carries
 * `error` for a verified secret and `warning` for the rest, so a secret that could not be verified
 * (the provider was unreachable, and it may well be live) cannot be told from one the provider
 * rejected. The title is also the detector's whole description rather than its name. The JSON keeps
 * `Verified` and `VerificationError`, hence Critical, High and Medium here instead of High and Medium.
 */

import type { Finding } from './finding.js'

export interface TrufflehogLine {
  DetectorName?: string
  DetectorDescription?: string
  DecoderName?: string
  Verified?: boolean
  VerificationError?: string
  SourceMetadata?: {
    Data?: {
      Filesystem?: { file?: string; line?: number }
      Git?: { file?: string; line?: number; commit?: string }
    }
  }
}

export function isTrufflehogLine(value: unknown): value is TrufflehogLine {
  if (typeof value !== 'object' || value === null) return false
  const line = value as TrufflehogLine
  return typeof line.DetectorName === 'string' && typeof line.SourceMetadata === 'object'
}

/** One finding per non-empty line; lines that are not findings (log output) are skipped. */
export function parseTrufflehog(content: string): TrufflehogLine[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed: unknown = JSON.parse(line)
        return isTrufflehogLine(parsed) ? [parsed] : []
      } catch {
        return []
      }
    })
}

/**
 * A verified secret is live and exploitable, so Critical. One that could not be verified (the
 * provider was unreachable) may well be live, so High. An unverified one was rejected by the
 * provider, or has no verifier, and is worth a look rather than a page.
 */
function severityOf(line: TrufflehogLine): Finding['severity'] {
  if (line.Verified) return 'Critical'
  return line.VerificationError ? 'High' : 'Medium'
}

export function flattenTrufflehog(lines: TrufflehogLine[]): Finding[] {
  return lines.map(line => {
    const source = line.SourceMetadata?.Data?.Filesystem ?? line.SourceMetadata?.Data?.Git
    const severity = severityOf(line)
    const detector = line.DetectorName ?? 'unknown'
    const state = line.Verified ? 'verified' : line.VerificationError ? 'unverifiable' : 'unverified'
    return {
      tool: 'TruffleHog',
      toolVersion: '',
      ruleId: detector,
      ruleName: detector,
      level: severity === 'Critical' || severity === 'High' ? 'error' : 'warning',
      severity,
      title: `${detector} secret (${state})`,
      description: line.DetectorDescription ?? '',
      tags: ['secret', state],
      cwes: ['CWE-798'],
      file: source?.file,
      startLine: source?.line || undefined,
      remediation: 'Rotate the credential, then remove it from the repository.'
    }
  })
}
