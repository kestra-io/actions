import * as core from '@actions/core'
import * as github from '@actions/github'
import * as glob from '@actions/glob'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { authHeaders, bulkUrl, chunk, dataStreamName, sendBulk, toNdjson, validateDataStream } from '../../../shared/elastic-core/src/bulk.js'
import { githubMetadata } from '../../../shared/elastic-core/src/github.js'
import { parseBoolean, parseList, parsePairs } from '../../../shared/elastic-core/src/inputs.js'
import { downloadBaseline, findBaselineRun, uploadBaseline } from './baseline.js'
import { buildComment } from './comment.js'
import { parseCobertura } from './cobertura.js'
import { detectFormat } from './detect.js'
import { toDocument, type DocumentContext } from './documents.js'
import { parseJacoco } from './jacoco.js'
import { parseLcov } from './lcov.js'
import { detectModule } from './modules.js'
import { pct } from './model.js'
import type { FileCoverage } from './model.js'
import { buildSummary, type CoverageSummary } from './summary.js'

/** Detected from content, since a report's extension says nothing reliable about its format. */
async function readReport(file: string, workspace: string): Promise<FileCoverage[]> {
  const content = await fs.readFile(file, 'utf8')
  const format = detectFormat(content)
  switch (format) {
    case 'jacoco':
      return parseJacoco(content, file, workspace)
    case 'cobertura':
      return parseCobertura(content, workspace)
    case 'lcov':
      return parseLcov(content, workspace)
    default:
      core.warning(`Could not detect the coverage format of ${file}; skipping it`)
      return []
  }
}

/** Github Actions turns a required workflow_id into "owner/repo/.github/workflows/x.yml", trim to the filename. */
function workflowFile(workflowRef: string): string {
  return workflowRef.split('@')[0]?.split('/').pop() ?? ''
}

function finish(documents: number, sent: number, markdown: string, markdownFile: string, skipped: boolean): void {
  core.setOutput('documents-count', String(documents))
  core.setOutput('sent-count', String(sent))
  core.setOutput('markdown', markdown)
  core.setOutput('markdown-file', markdownFile)
  core.setOutput('skipped', String(skipped))
}

async function run(): Promise<void> {
  const patterns = core.getInput('coverage-files')
  const namespace = core.getInput('namespace') || 'gha'
  const component = core.getInput('component', { required: true })
  const moduleOverrides = parsePairs(core.getInput('modules'))
  const baseBranch = core.getInput('base-branch') || 'develop'
  const failOnError = parseBoolean(core.getInput('fail-on-error'))
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const temp = process.env.RUNNER_TEMP ?? process.cwd()
  const markdownFile = path.join(temp, `coverage-comment-${component}.md`)

  const githubContext = githubMetadata(process.env)
  const uploadBaselineDefault = githubContext.refType === 'branch' && githubContext.refName === baseBranch
  const shouldUploadBaseline = parseBoolean(core.getInput('upload-baseline'), uploadBaselineDefault)

  const files = patterns.trim() ? await (await glob.create(patterns, { matchDirectories: false })).glob() : []
  if (files.length === 0) {
    core.warning(patterns.trim() ? `No coverage file matched: ${patterns.split('\n').join(', ')}` : 'No coverage-files supplied, the tests that produce it most likely skipped')
    finish(0, 0, '', markdownFile, true)
    return
  }
  core.info(`Coverage files: ${files.map(file => path.relative(workspace, file)).join(', ')}`)

  const byPath = new Map<string, FileCoverage>()
  for (const file of files) {
    for (const coverage of await readReport(file, workspace)) {
      const existing = byPath.get(coverage.path)
      // The same file reported by two runs (unit + integration) is combined by keeping the fuller
      // counter, not by adding them — adding would double count a line both agree was hit.
      byPath.set(coverage.path, existing ? mergeFileCoverage(existing, coverage) : coverage)
    }
  }

  const filesWithModules = [...byPath.values()].map(file => ({ ...file, module: detectModule(file.path, workspace, moduleOverrides) }))

  if (filesWithModules.length === 0) {
    core.info('No file coverage parsed from the report(s); nothing to ship.')
    finish(0, 0, '', markdownFile, false)
    return
  }

  const context: DocumentContext = {
    component,
    namespace,
    github: githubContext,
    scanTime: new Date().toISOString(),
    tags: parseList(core.getInput('tags')),
    metadata: parsePairs(core.getInput('metadata'))
  }

  const stream = dataStreamName('coverage', namespace)
  const invalid = validateDataStream(stream)
  if (invalid) {
    core.setFailed(invalid)
    return
  }

  const documents = filesWithModules.map(file => toDocument(file, context))
  const size = Math.max(1, Number(core.getInput('batch-size') || '500'))
  const batches = chunk(documents, size)
  const ndjsonFile = path.join(temp, 'elastic-coverage-bulk.ndjson')
  await fs.writeFile(ndjsonFile, batches.map(batch => toNdjson(batch, stream)).join(''))

  const summary = buildSummary(filesWithModules, {
    repository: githubContext.repository,
    component,
    sha: githubContext.sha,
    runId: githubContext.runId
  })

  const baseline = await resolveBaseline(summary, baseBranch, component, temp)
  const markdown = buildComment(summary, baseline)
  await fs.writeFile(markdownFile, markdown)
  core.info(markdown)

  core.setOutput('line-rate', String(pct(summary.totals.lines)))
  if (baseline) {
    const delta = pct(summary.totals.lines) - pct(baseline.totals.lines)
    core.setOutput('base-line-rate', String(pct(baseline.totals.lines)))
    core.setOutput('delta', String(Math.round(delta * 100) / 100))
  }

  if (shouldUploadBaseline) {
    try {
      await uploadBaseline(summary, component, temp)
      core.info(`Uploaded coverage baseline for ${component}`)
    } catch (error) {
      core.warning(`Could not upload the coverage baseline: ${(error as Error).message}`)
    }
  }

  const documentCount = documents.length
  if (parseBoolean(core.getInput('dry-run'))) {
    core.info(`Dry run, payload written to ${ndjsonFile}`)
    finish(documentCount, 0, markdown, markdownFile, true)
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
      await sendBulk({ url, headers, body: toNdjson(batch, stream), onRetry: message => core.warning(message) })
      sent += batch.length
    }
  } catch (error) {
    const message = `Could not ship coverage to Elastic: ${(error as Error).message}`
    finish(documentCount, sent, markdown, markdownFile, true)
    if (failOnError) core.setFailed(message)
    else core.warning(message)
    return
  }

  core.info(`Accepted ${sent} document(s) into ${stream}`)
  finish(documentCount, sent, markdown, markdownFile, false)
}

function mergeFileCoverage(a: FileCoverage, b: FileCoverage): FileCoverage {
  const better = (x: FileCoverage['lines'], y: FileCoverage['lines']) => (x.covered + x.missed >= y.covered + y.missed ? x : y)
  return {
    path: a.path,
    format: a.format,
    lines: better(a.lines, b.lines),
    branches: a.branches && b.branches ? better(a.branches, b.branches) : (a.branches ?? b.branches),
    functions: a.functions && b.functions ? better(a.functions, b.functions) : (a.functions ?? b.functions)
  }
}

/** Not found is normal (develop has no run yet, or the token cannot read Actions) — never a failure. */
async function resolveBaseline(summary: CoverageSummary, baseBranch: string, component: string, temp: string): Promise<CoverageSummary | undefined> {
  const token = core.getInput('github-token')
  if (!token) {
    core.info('No github-token supplied; skipping the develop baseline comparison.')
    return undefined
  }
  if (github.context.ref === `refs/heads/${baseBranch}`) return undefined

  try {
    const octokit = github.getOctokit(token)
    const { owner, repo } = github.context.repo
    const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? ''
    const runId = await findBaselineRun(octokit, owner, repo, workflowFile(workflowRef), baseBranch, component)
    if (!runId) {
      core.info(`No coverage baseline found on ${baseBranch} yet.`)
      return undefined
    }
    return await downloadBaseline(runId, component, owner, repo, token, temp)
  } catch (error) {
    core.warning(`Could not fetch the coverage baseline: ${(error as Error).message}`)
    return undefined
  }
}

run().catch((error: Error) => core.setFailed(error.message))
