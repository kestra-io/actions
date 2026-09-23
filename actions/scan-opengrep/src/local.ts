/**
 * Run the same scan CI runs, locally.
 *
 * `opengrep scan --config .opengrep/settings.yml` cannot work: --config takes a rules file and
 * OpenGrep has no settings-file concept, so something must translate settings into flags. Worse,
 * not every setting *is* a flag — ignore-findings and fail-on-severity are applied to the report
 * after opengrep exits. So the printed command alone gives the unsuppressed result, and only this
 * entrypoint reproduces what CI reports. It shares the action's own modules, so the two cannot
 * drift.
 *
 *   npm run scan -- /path/to/repo            # same numbers as CI
 *   npm run scan -- /path/to/repo --print    # print the opengrep command only
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { actionRepoRoot, loadConfig, resolveSettings } from './config.js'
import { blockingCount, normaliseReport, parseFailOn, summarise, type OpengrepReport } from './findings.js'
import { buildRuleset, resolveRulesets } from './rules.js'
import { buildScanArgs, parseSeverities } from './scan.js'
import { applySuppressions, describeSuppression } from './suppress.js'

const quote = (value: string): string => (/[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value)

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const printOnly = args.includes('--print')
  const target = args.find(a => !a.startsWith('--')) ?? '.'
  const root = path.resolve(target)

  const configDir = path.join(root, '.opengrep')
  const { config, fromFallback } = await loadConfig(
    configDir,
    path.join(actionRepoRoot(import.meta.url), '.opengrep')
  )
  const settings = resolveSettings(config)
  if (fromFallback) console.log('(using the kestra-io/actions fallback settings)')
  console.log()

  const { rulesets } = resolveRulesets(settings.rulesets)
  const localRules = path.join(configDir, 'rules')
  const ruleset = buildRuleset(rulesets, existsSync(localRules) ? localRules : null)

  const json = path.join(root, '.opengrep-local.json')
  const argv = buildScanArgs({
    ruleset,
    scanPath: '.',
    severities: parseSeverities(settings.severity),
    jsonOutput: json,
    sarifOutput: path.join(root, '.opengrep-local.sarif'),
    excludeRules: settings.excludeRules,
    excludePaths: settings.excludePaths
  })

  console.log(`opengrep ${argv.map(quote).join(' ')}\n`)
  if (printOnly) {
    if (settings.ignoreFindings.length > 0) {
      console.log(
        `note: ${settings.ignoreFindings.length} ignore-findings rule(s) are applied after this ` +
          'command by the action, so running it alone reports more findings than CI does.'
      )
    }
    return
  }

  const run = spawnSync('opengrep', argv, { cwd: root, stdio: 'inherit' })
  if (run.error) {
    throw new Error(`Could not run opengrep: ${run.error.message}. Install it from https://github.com/opengrep/opengrep/releases`)
  }

  const report = normaliseReport(JSON.parse(readFileSync(json, 'utf8')) as OpengrepReport, ruleset.root)
  const { report: kept, suppressions } = applySuppressions(report, settings.ignoreFindings, file =>
    readFileSync(path.join(root, file), 'utf8').split('\n')
  )
  for (const suppression of suppressions) console.log(`suppressed ${describeSuppression(suppression)}`)

  const raw = summarise(report)
  const summary = summarise(kept)
  const dropped = raw.total - summary.total
  console.log(
    `\n${raw.total} finding(s) from opengrep, ${dropped} dropped by ignore-findings` +
      `\n${summary.total} reported: ${summary.ERROR} error, ${summary.WARNING} warning, ${summary.INFO} info`
  )

  const blocking = blockingCount(summary, parseFailOn(settings.failOnSeverity))
  if (blocking > 0) {
    console.error(`\nfail-on-severity=${settings.failOnSeverity}: ${blocking} finding(s) would fail CI`)
    process.exitCode = 1
  }
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
