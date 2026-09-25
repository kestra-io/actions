import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { toAnnotations } from './annotations.js'
import { resolveBaseline } from './baseline.js'
import { publishCheckRun } from './checks.js'
import { actionRepoRoot, loadConfig, resolveSettings, shortRuleIds } from './config.js'
import {
  blockingCount,
  fatalMessages,
  normaliseReport,
  normaliseSarif,
  parseFailOn,
  scanDidNotRun,
  scannedNothing,
  summarise,
  type OpengrepReport
} from './findings.js'
import { installOpengrep } from './install.js'
import { buildCommentModel, renderStepSummary } from './report.js'
import { buildRuleset, resolveRulesets } from './rules.js'
import { stringify as stringifyYaml } from 'yaml'
import { buildScanArgs, parseMode, parseSeverities, resolveMode } from './scan.js'
import { REGISTRY_HOST } from './version.js'

const ARTIFACT_NAME = 'opengrep-report'

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

async function run(): Promise<void> {
  const configDir = core.getInput('config-dir') || '.opengrep'
  const token = core.getInput('github-token')
  const scanPath = core.getInput('scan-path') || '.'

  // The scanned repository's own settings, or the one shipped in kestra-io/actions when it has none.
  const loaded = await loadConfig(configDir, path.join(actionRepoRoot(import.meta.url), '.opengrep'))
  const settings = resolveSettings(loaded.config)
  const mode = parseMode(core.getInput('mode') || 'auto')
  const severities = parseSeverities(core.getInput('severity') || 'ERROR,WARNING')
  const failOn = parseFailOn(core.getInput('fail-on-severity') || 'none')

  for (const id of shortRuleIds(settings.excludeRules)) {
    core.warning(`exclude-rules entry '${id}' has no dots; --exclude-rule matches the full rule id, so this drops nothing.`)
  }

  const maxRows = Number(core.getInput('comment-max-rows') || '50')
  const checkName = core.getInput('check-name') || 'OpenGrep'

  const temp = process.env.RUNNER_TEMP ?? process.cwd()
  const jsonOutput = path.join(temp, 'opengrep.json')
  const sarifOutput = path.join(temp, 'opengrep.sarif')

  const { rulesets } = resolveRulesets(settings.rulesets)

  // Inline `rules:` become a real rules file. It goes in RUNNER_TEMP, never the workspace: opengrep
  // reads a --config value starting `p/` or `r/` as a registry reference rather than a path.
  let localRulesFile: string | null = null
  if (settings.rules.length > 0) {
    localRulesFile = path.join(temp, 'opengrep-repository-rules.yml')
    await fs.writeFile(localRulesFile, stringifyYaml({ rules: settings.rules }))
    core.info(`Repository rules: ${settings.rules.length} from ${loaded.source}`)
  }
  const ruleset = buildRuleset(rulesets, localRulesFile)
  core.info(`Rulesets: ${rulesets.join(', ')} (fetched from ${REGISTRY_HOST} at scan time)`)
  if (settings.excludeRules.length > 0) core.info(`Excluded rules: ${settings.excludeRules.join(', ')}`)

  const { binary: opengrep, release } = await installOpengrep(
    core.getInput('opengrep-version') || 'latest',
    process.env.RUNNER_ARCH ?? 'X64',
    token
  )

  const resolved = resolveMode(mode, github.context.eventName)
  const baseline =
    resolved === 'diff'
      ? await resolveBaseline({
          baseRef: github.context.payload.pull_request?.base?.ref,
          baseSha: github.context.payload.pull_request?.base?.sha
        })
      : null
  const effectiveMode = resolved === 'diff' && !baseline ? 'full' : resolved
  core.info(`Mode: ${effectiveMode}${baseline ? ` (baseline ${baseline})` : ''}`)

  await exec.exec(
    opengrep,
    buildScanArgs({
      ruleset,
      scanPath,
      severities,
      jsonOutput,
      sarifOutput,
      baseline: baseline ?? undefined,
      excludeRules: settings.excludeRules,
      excludePaths: settings.excludePaths
    }),
    { ignoreReturnCode: true }
  )

  const skip = (reason: string): void => {
    // Deliberately not setFailed: rules are fetched from the registry at scan time, so the usual
    // cause is that host being unreachable or rate limiting. That is an infrastructure problem and
    // must not redden an unrelated pull request. It is a warning rather than silence because the
    // one thing worse is reporting "0 findings" for a scan that never looked at anything.
    core.warning(`OpenGrep did not run: ${reason}. Skipping the scan for this run.`)
    core.setOutput('summary', JSON.stringify({ ERROR: 0, WARNING: 0, INFO: 0, total: 0, parseErrors: 0, fatalErrors: 0, filesScanned: 0 }))
    core.setOutput('findings-count', '0')
    core.setOutput('skipped', 'true')
  }

  if (!(await exists(jsonOutput))) {
    skip(`no report was produced, rules are fetched from ${REGISTRY_HOST} at scan time`)
    return
  }

  const report = normaliseReport(await readJson<OpengrepReport>(jsonOutput), ruleset.root)
  await fs.writeFile(jsonOutput, JSON.stringify(report, null, 2))
  if (await exists(sarifOutput)) {
    await fs.writeFile(sarifOutput, JSON.stringify(normaliseSarif(await readJson(sarifOutput), ruleset.root), null, 2))
  }

  const summary = summarise(report)

  // A report can exist and still mean nothing: a failed rule download yields zero results and zero
  // files scanned, which would otherwise render as a clean build.
  if (scanDidNotRun(summary)) {
    const detail = fatalMessages(report)
    skip(detail.length > 0 ? detail.join('; ') : `it reported an error but no detail`)
    return
  }

  if (scannedNothing(summary)) {
    core.info(`No files under '${scanPath}' matched the languages of the selected rulesets.`)
  }

  const model = buildCommentModel(report, maxRows)
  const markdown = renderStepSummary({
    mode: effectiveMode,
    rulesSource: loaded.fromFallback ? `${ruleset.source} (kestra-io/actions config)` : ruleset.source,
    engineVersion: release.version,
    summary,
    model,
    artifactName: ARTIFACT_NAME
  })

  // No core.summary write here: the pull request comment (comment-update, driven by
  // opengrep-comment.json) and the check run summary below already carry this markdown.
  await fs.writeFile(path.join(temp, 'opengrep-comment.json'), JSON.stringify(model, null, 2))

  const blocking = blockingCount(summary, failOn)

  core.setOutput('json-file', jsonOutput)
  core.setOutput('sarif-file', sarifOutput)
  core.setOutput('comment-file', path.join(temp, 'opengrep-comment.json'))
  core.setOutput('summary', JSON.stringify(summary))
  core.setOutput('findings-count', String(summary.total))
  core.setOutput('markdown', markdown)
  core.setOutput('skipped', 'false')

  if (token) {
    try {
      await publishCheckRun({
        token,
        name: checkName,
        title: `${summary.total} finding(s)`,
        summary: markdown,
        annotations: toAnnotations(report.results ?? []),
        conclusion: blocking > 0 ? 'failure' : 'success'
      })
    } catch (error) {
      // Annotations are a reporting nicety; the summary, outputs and artifact already carry the
      // findings, so a missing checks:write permission must not fail an otherwise clean scan.
      core.warning(`Could not publish annotations: ${(error as Error).message}`)
    }
  } else {
    core.info('No github-token supplied, skipping check run annotations.')
  }

  // Last, so every report above is published before this can end the step.
  if (blocking > 0) {
    core.setFailed(`OpenGrep found ${blocking} finding(s) at or above ${failOn}.`)
  }
}

run().catch((error: Error) => core.setFailed(error.message))
