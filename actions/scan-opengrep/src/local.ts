/**
 * Run the same scan CI runs, locally.
 *
 * `opengrep scan --config .opengrep/settings.yml` cannot work: --config takes a rules file, and
 * OpenGrep has no settings-file concept, so something has to translate settings into flags. This
 * entrypoint is that translation — and it is the *same* code the action uses, so local and CI
 * cannot drift. It prints the command before running it, so the flags can be copied and adjusted.
 *
 *   npm run scan                 # scan the current directory
 *   npm run scan -- ../../        # scan somewhere else
 *   npm run scan -- . --print     # print the command without running it
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
  if (printOnly) return

  const run = spawnSync('opengrep', argv, { cwd: root, stdio: 'inherit' })
  if (run.error) {
    throw new Error(`Could not run opengrep: ${run.error.message}. Install it from https://github.com/opengrep/opengrep/releases`)
  }

  const report = normaliseReport(JSON.parse(readFileSync(json, 'utf8')) as OpengrepReport, ruleset.root)
  const { report: kept, suppressions } = applySuppressions(report, settings.ignoreFindings, file =>
    readFileSync(path.join(root, file), 'utf8').split('\n')
  )
  for (const suppression of suppressions) console.log(`suppressed ${describeSuppression(suppression)}`)

  const summary = summarise(kept)
  console.log(`\n${summary.total} finding(s): ${summary.ERROR} error, ${summary.WARNING} warning, ${summary.INFO} info`)

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
