import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { toAnnotations } from './annotations.js'
import { resolveBaseline } from './baseline.js'
import { publishCheckRun } from './checks.js'
import { parseConfig, resolveSettings, type OpengrepConfig } from './config.js'
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
import { applySuppressions, describeSuppression } from './suppress.js'
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

async function loadConfig(configDir: string): Promise<OpengrepConfig> {
  for (const name of ['config.yml', 'config.yaml']) {
    const file = path.join(configDir, name)
    if (await exists(file)) {
      core.info(`Using repository configuration: ${file}`)
      return parseConfig(await fs.readFile(file, 'utf8'))
    }
  }
  return {}
}

async function run(): Promise<void> {
  const configDir = core.getInput('config-dir') || '.opengrep'
  const token = core.getInput('github-token')

  const settings = resolveSettings(await loadConfig(configDir), {
    rulesets: core.getInput('rulesets'),
    mode: core.getInput('mode') || 'auto',
    severity: core.getInput('severity') || 'ERROR,WARNING',
    failOnSeverity: core.getInput('fail-on-severity') || 'none'
  })
  const scanPath = core.getInput('scan-path') || '.'

  const mode = parseMode(settings.mode)
  const severities = parseSeverities(settings.severity)
  const failOn = parseFailOn(settings.failOnSeverity)
  const maxRows = Number(core.getInput('comment-max-rows') || '50')
  const checkName = core.getInput('check-name') || 'OpenGrep'

  const temp = process.env.RUNNER_TEMP ?? process.cwd()
  const jsonOutput = path.join(temp, 'opengrep.json')
  const sarifOutput = path.join(temp, 'opengrep.sarif')

  const { rulesets, unknown } = resolveRulesets(settings.rulesets)
  for (const pack of unknown) {
    core.warning(`Ruleset '${pack}' is not one of the packs known to resolve; if the scan cannot fetch it, check the name.`)
  }

  // A repository's own rules sit alongside the registry packs, not instead of them.
  const localRulesDir = path.join(configDir, 'rules')
  const ruleset = buildRuleset(rulesets, (await exists(localRulesDir)) ? localRulesDir : null)
  core.info(`Rulesets: ${rulesets.join(', ')} (fetched from ${REGISTRY_HOST} at scan time)`)
  if (ruleset.source !== 'registry') core.info(`Plus repository rules: ${localRulesDir}`)
  if (settings.excludeRules.length > 0) core.info(`Excluded rules: ${settings.excludeRules.length}`)

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

  const scanned = normaliseReport(await readJson<OpengrepReport>(jsonOutput), ruleset.root)

  // Suppression runs after normalisation, so ignore rules match the clean ids a human would write,
  // and before everything downstream, so a suppressed finding reaches neither the gate, the
  // annotations, nor the comment.
  // Some suppressions need the lines around a finding, not just the finding. Memoised because a
  // file typically carries several findings and each would otherwise re-read it.
  const lineCache = new Map<string, string[]>()
  const readLines = (file: string): string[] => {
    let lines = lineCache.get(file)
    if (!lines) {
      try {
        lines = readFileSync(file, 'utf8').split('\n')
      } catch {
        lines = []
      }
      lineCache.set(file, lines)
    }
    return lines
  }

  const { report, suppressions, total: suppressed } = applySuppressions(scanned, settings.ignoreFindings, readLines)
  for (const suppression of suppressions) {
    // Logged even at zero: a suppression that quietly stops matching, because the rule id moved
    // upstream or the pattern no longer fits, should be visible rather than discovered later.
    core.info(`Suppressed ${describeSuppression(suppression)}`)
  }
  if (suppressed > 0) core.info(`${suppressed} finding(s) suppressed by ignore-findings.`)

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
    await core.summary
      .addRaw(`### 🔎 OpenGrep\n\n⚠️ The scan did not run, so this is **not** a clean result.\n\n${detail.map(d => `- ${d}`).join('\n')}`)
      .write()
    return
  }

  if (scannedNothing(summary)) {
    core.info(`No files under '${scanPath}' matched the languages of the selected rulesets.`)
  }

  const model = buildCommentModel(report, maxRows)
  const markdown = renderStepSummary({
    mode: effectiveMode,
    rulesSource: ruleset.source,
    engineVersion: release.version,
    summary,
    model,
    artifactName: ARTIFACT_NAME
  })

  await core.summary.addRaw(markdown).write()
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
