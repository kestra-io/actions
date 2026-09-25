import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { authHeaders, bulkUrl, chunk, dataStreamName, sendBulk, toNdjson, validateDataStream } from './bulk.js'
import { toDocument, type DocumentContext } from './documents.js'
import { githubMetadata } from './github.js'
import { parseBoolean, parseList, parsePairs } from './inputs.js'
import { flatten, type Finding, type SarifLog } from './sarif.js'

async function readSarif(file: string): Promise<Finding[]> {
  try {
    return flatten(JSON.parse(await fs.readFile(file, 'utf8')) as SarifLog)
  } catch (error) {
    core.warning(`Could not read ${file} as SARIF: ${(error as Error).message}`)
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
  const dataset = core.getInput('dataset') || 'security_scan.findings'
  const namespace = core.getInput('namespace') || 'github-actions'
  const dataStream = dataStreamName(dataset, namespace)
  const invalid = validateDataStream(dataStream)
  // A config error, not an infrastructure one: silently dropped documents are worse than a red step.
  if (invalid) {
    core.setFailed(invalid)
    return
  }

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
    github: githubMetadata(process.env),
    scanTime: new Date().toISOString(),
    tags: parseList(core.getInput('tags')),
    metadata: parsePairs(core.getInput('metadata'))
  }

  const findings = (await Promise.all(files.map(readSarif))).flat()
  const documents = findings.map(finding => toDocument(finding, context))

  const batches = chunk(documents, Math.max(1, Number(core.getInput('batch-size') || '500')))
  const payload = batches.map(batch => toNdjson(batch, dataStream)).join('')
  await fs.writeFile(ndjsonFile, payload)

  const bySeverity = documents.reduce<Record<string, number>>((counts, document) => {
    const severity = String((document.vulnerability as Record<string, unknown>)?.severity ?? 'Unknown')
    counts[severity] = (counts[severity] ?? 0) + 1
    return counts
  }, {})
  core.info(`${documents.length} finding(s) for ${dataStream}: ${JSON.stringify(bySeverity)}`)

  if (documents.length === 0) {
    core.info('Nothing to ship.')
    finish(0, 0, ndjsonFile, false)
    return
  }

  if (parseBoolean(core.getInput('dry-run'))) {
    core.info(`Dry run, payload written to ${ndjsonFile}`)
    finish(documents.length, 0, ndjsonFile, true)
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
    for (const batch of batches) {
      await sendBulk({ url, headers, body: toNdjson(batch, dataStream), onRetry: message => core.warning(message) })
      sent += batch.length
    }
  } catch (error) {
    const message = `Could not ship findings to Elastic: ${(error as Error).message}`
    finish(documents.length, sent, ndjsonFile, true)
    // Matches otel-export-trace: an unreachable ingest endpoint is an infrastructure problem and
    // must not redden a pull request whose scan itself succeeded, unless the caller opts in.
    if (failOnError) core.setFailed(message)
    else core.warning(message)
    return
  }

  // A 2xx means the managed input durably accepted the batch, not that Elasticsearch indexed it;
  // indexing errors surface asynchronously in Data Set Quality, never in this response.
  core.info(`Accepted ${sent} document(s) into ${dataStream}`)
  finish(documents.length, sent, ndjsonFile, false)
}

run().catch((error: Error) => core.setFailed(error.message))
