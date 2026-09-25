import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { authHeaders, bulkUrl, chunk, dataStreamName, sendBulk, toNdjson, validateDataStream } from './bulk.js'
import { datasetOf, toDocument, type DocumentContext, type FindingType } from './documents.js'
import { githubMetadata } from './github.js'
import { parseBoolean, parseList, parsePairs } from './inputs.js'
import type { Finding } from './finding.js'
import { flatten, type SarifLog } from './sarif.js'
import { flattenTrivy, isTrivyReport } from './trivy.js'

/**
 * SARIF, or Trivy's own JSON when that is what was handed over. Detected by shape rather than by
 * file extension, since both formats are .json as often as not — and Trivy's native report is worth
 * preferring where it exists, because SARIF drops its advisory, publication and per-vendor CVSS
 * fields.
 */
async function readReport(file: string): Promise<Finding[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return isTrivyReport(parsed) ? flattenTrivy(parsed) : flatten(parsed as SarifLog)
  } catch (error) {
    core.warning(`Could not read ${file} as SARIF or a Trivy report: ${(error as Error).message}`)
    return []
  }
}

function finish(documents: number, sent: number, ndjsonFile: string, skipped: boolean): void {
  core.setOutput('documents-count', String(documents))
  core.setOutput('sent-count', String(sent))
  core.setOutput('ndjson-file', ndjsonFile)
  core.setOutput('skipped', String(skipped))
}

async function run(): Promise<void> {
  // Not getInput({ required: true }): the usual wiring passes a scan step's sarif-file output, and
  // that is empty whenever the scan itself skipped — a warning, not a failed step.
  const patterns = core.getInput('sarif-files')
  // Empty means one data stream per scanner, named after it: logs-opengrep-gha, logs-trivy-gha.
  const dataset = core.getInput('dataset')
  const namespace = core.getInput('namespace') || 'gha'
  const rawType = (core.getInput('type') || 'vulnerabilities').trim().toLowerCase()
  if (rawType !== 'vulnerabilities' && rawType !== 'misconfigurations') {
    core.setFailed(`type must be vulnerabilities or misconfigurations, got '${rawType}'`)
    return
  }
  const type = rawType as FindingType

  const temp = process.env.RUNNER_TEMP ?? process.cwd()
  const ndjsonFile = path.join(temp, 'elastic-bulk.ndjson')
  const failOnError = parseBoolean(core.getInput('fail-on-error'))

  const files = patterns.trim() ? await (await glob.create(patterns, { matchDirectories: false })).glob() : []
  if (files.length === 0) {
    // The scan that should have produced these may legitimately have skipped — see scan-opengrep's
    // registry fallback — so this is a warning, never a failure.
    core.warning(patterns.trim() ? `No SARIF file matched: ${patterns.split('\n').join(', ')}` : 'No SARIF file supplied, the scan that produces it most likely skipped')
    finish(0, 0, ndjsonFile, true)
    return
  }
  core.info(`SARIF files: ${files.map(file => path.relative(process.cwd(), file)).join(', ')}`)

  const context: DocumentContext = {
    dataset,
    namespace,
    type,
    github: githubMetadata(process.env),
    scanTime: new Date().toISOString(),
    tags: parseList(core.getInput('tags')),
    metadata: parsePairs(core.getInput('metadata'))
  }

  const findings = (await Promise.all(files.map(readReport))).flat()

  // Grouped by target rather than shipped as one stream: each scanner writes its own
  // logs-<tool>-<namespace>, so one tool's volume never buries another's.
  const byStream = new Map<string, Record<string, unknown>[]>()
  for (const finding of findings) {
    const stream = dataStreamName(datasetOf(finding, context), namespace)
    const invalid = validateDataStream(stream)
    // A config error, not an infrastructure one: silently dropped documents are worse than a red step.
    if (invalid) {
      core.setFailed(invalid)
      return
    }
    const documents = byStream.get(stream) ?? []
    documents.push(toDocument(finding, context))
    byStream.set(stream, documents)
  }

  const size = Math.max(1, Number(core.getInput('batch-size') || '500'))
  const batches = [...byStream].flatMap(([stream, documents]) =>
    chunk(documents, size).map(batch => ({ stream, batch }))
  )
  const documentCount = findings.length
  await fs.writeFile(ndjsonFile, batches.map(({ stream, batch }) => toNdjson(batch, stream)).join(''))

  for (const [stream, documents] of byStream) {
    const bySeverity = documents.reduce<Record<string, number>>((counts, document) => {
      const severity = String(
        ((document.vulnerability ?? document.rule) as Record<string, unknown>)?.severity ?? 'Unknown'
      )
      counts[severity] = (counts[severity] ?? 0) + 1
      return counts
    }, {})
    core.info(`${documents.length} ${type} finding(s) for ${stream}: ${JSON.stringify(bySeverity)}`)
  }

  if (documentCount === 0) {
    core.info('Nothing to ship.')
    finish(0, 0, ndjsonFile, false)
    return
  }

  if (parseBoolean(core.getInput('dry-run'))) {
    core.info(`Dry run, payload written to ${ndjsonFile}`)
    finish(documentCount, 0, ndjsonFile, true)
    return
  }

  const url = bulkUrl(core.getInput('elastic-endpoint', { required: true }))
  const headers = authHeaders(core.getInput('elastic-headers'), core.getInput('elastic-api-key'))
  if (!headers.Authorization) {
    core.setFailed('Supply elastic-headers (the OTLP_HEADERS secret) or elastic-api-key; neither carries an Authorization header.')
    return
  }
  core.info(`Shipping ${batches.length} batch(es) to ${url}`)

  let sent = 0
  try {
    for (const { stream, batch } of batches) {
      await sendBulk({ url, headers, body: toNdjson(batch, stream), onRetry: message => core.warning(message) })
      sent += batch.length
    }
  } catch (error) {
    const message = `Could not ship findings to Elastic: ${(error as Error).message}`
    finish(documentCount, sent, ndjsonFile, true)
    // Matches otel-export-trace: an unreachable ingest endpoint is an infrastructure problem and
    // must not redden a pull request whose scan itself succeeded, unless the caller opts in.
    if (failOnError) core.setFailed(message)
    else core.warning(message)
    return
  }

  // A 2xx means the managed input durably accepted the batch, not that Elasticsearch indexed it;
  // indexing errors surface asynchronously in Data Set Quality, never in this response.
  core.info(`Accepted ${sent} document(s) into ${[...byStream.keys()].join(', ')}`)
  finish(documentCount, sent, ndjsonFile, false)
}

run().catch((error: Error) => core.setFailed(error.message))
