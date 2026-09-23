/**
 * Run the same scan CI runs, locally.
 *
 * `opengrep scan --config .opengrep/settings.yml` cannot work: --config takes a rules file and
 * OpenGrep has no settings-file concept, so something must turn settings into flags. This is that
 * translation, sharing the action's own modules so the two cannot drift.
 *
 * Every setting does map to a flag, so the command printed here is the whole scan — running it by
 * hand gives exactly what CI reports.
 *
 *   npm run scan -- /path/to/repo                    # run it
 *   npm run scan -- /path/to/repo --print            # print the command only
 *   npm run scan -- /path/to/repo --severity ERROR   # default is ERROR,WARNING
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { actionRepoRoot, loadConfig, resolveSettings, shortRuleIds } from './config.js'
import { normaliseReport, summarise, type OpengrepReport } from './findings.js'
import { buildRuleset, resolveRulesets } from './rules.js'
import { buildScanArgs, parseSeverities } from './scan.js'

const quote = (value: string): string => (/[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value)

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const printOnly = args.includes('--print')
  const target = args.find(a => !a.startsWith('--')) ?? '.'
  const root = path.resolve(target)

  const { config, fromFallback } = await loadConfig(
    path.join(root, '.opengrep'),
    path.join(actionRepoRoot(import.meta.url), '.opengrep')
  )
  const settings = resolveSettings(config)
  if (fromFallback) console.log('(using the kestra-io/actions fallback settings)')
  for (const id of shortRuleIds(settings.excludeRules)) {
    console.log(`warning: exclude-rules entry '${id}' has no dots; --exclude-rule needs the full id and drops nothing.`)
  }

  // Outside the scanned tree on purpose: opengrep reads a --config value starting `p/` or `r/` as a
  // registry reference, so a rules file written into the workspace can be fetched from semgrep.dev.
  let rulesFile: string | null = null
  if (settings.rules.length > 0) {
    rulesFile = path.join(os.tmpdir(), 'opengrep-repository-rules.yml')
    writeFileSync(rulesFile, stringifyYaml({ rules: settings.rules }))
  }

  const { rulesets } = resolveRulesets(settings.rulesets)
  const ruleset = buildRuleset(rulesets, rulesFile)
  const json = path.join(os.tmpdir(), 'opengrep-local.json')

  const argv = buildScanArgs({
    ruleset,
    scanPath: '.',
    severities: parseSeverities(flag(args, 'severity', 'ERROR,WARNING')),
    jsonOutput: json,
    sarifOutput: path.join(os.tmpdir(), 'opengrep-local.sarif'),
    excludeRules: settings.excludeRules,
    excludePaths: settings.excludePaths
  })

  console.log(`\nopengrep ${argv.map(quote).join(' ')}\n`)
  if (printOnly) return

  const run = spawnSync('opengrep', argv, { cwd: root, stdio: 'inherit' })
  if (run.error) {
    throw new Error(`Could not run opengrep: ${run.error.message}. Install it from https://github.com/opengrep/opengrep/releases`)
  }

  const report = normaliseReport(JSON.parse(readFileSync(json, 'utf8')) as OpengrepReport, ruleset.root)
  const summary = summarise(report)
  console.log(`\n${summary.total} finding(s): ${summary.ERROR} error, ${summary.WARNING} warning, ${summary.INFO} info`)
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
