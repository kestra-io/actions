import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findModuleRoot, parseJacoco, resolveJacocoPath } from './jacoco.js'

const FIXTURE = `<?xml version="1.0"?>
<!DOCTYPE report SYSTEM "report.dtd">
<report name="core">
  <package name="io/kestra/core">
    <sourcefile name="Foo.java">
      <counter type="METHOD" missed="1" covered="2"/>
      <counter type="LINE" missed="3" covered="7"/>
      <counter type="BRANCH" missed="1" covered="1"/>
    </sourcefile>
  </package>
</report>`

test('findModuleRoot climbs to the nearest ancestor with a build file', () => {
  const files = new Set(['/repo/core/build.gradle.kts'])
  const exists = (file: string) => files.has(file)
  assert.equal(findModuleRoot('/repo/core/build/reports/jacoco/test/jacocoTestReport.xml', '/repo', exists), '/repo/core')
})

test('findModuleRoot falls back to the workspace root when no build file is found', () => {
  assert.equal(findModuleRoot('/repo/core/build/report.xml', '/repo', () => false), '/repo')
})

test('resolveJacocoPath picks the first existing source root', () => {
  const files = new Set(['/repo/core/src/main/java/io/kestra/core/Foo.java'])
  const exists = (file: string) => files.has(file)
  assert.equal(resolveJacocoPath('/repo/core', 'io/kestra/core', 'Foo.java', '/repo', exists, () => []), 'core/src/main/java/io/kestra/core/Foo.java')
})

test('resolveJacocoPath falls back to <module>/<package>/<file> when nothing exists on disk', () => {
  assert.equal(resolveJacocoPath('/repo/core', 'io/kestra/core', 'Foo.java', '/repo', () => false, () => []), 'core/io/kestra/core/Foo.java')
})

test('resolveJacocoPath searches sibling modules when a root-level aggregate report has no source under it', () => {
  // Gradle's jacoco-report-aggregation plugin writes one combined report at the repo root, so
  // findModuleRoot resolves every package in it to the root itself — not to whichever subproject
  // the package actually belongs to.
  const files = new Set(['/repo/build.gradle', '/repo/cli/build.gradle', '/repo/core/build.gradle', '/repo/cli/src/main/java/io/kestra/cli/Foo.java'])
  const exists = (file: string) => files.has(file)
  const list = (dir: string) => (dir === '/repo' ? ['build.gradle', 'cli', 'core'] : [])
  assert.equal(resolveJacocoPath('/repo', 'io/kestra/cli', 'Foo.java', '/repo', exists, list), 'cli/src/main/java/io/kestra/cli/Foo.java')
})

test('resolveJacocoPath skips the module it already tried when searching siblings', () => {
  const files = new Set(['/repo/build.gradle', '/repo/cli/build.gradle'])
  const exists = (file: string) => files.has(file)
  let cliSourceRootChecks = 0
  const countingExists = (file: string) => {
    if (file.startsWith('/repo/cli/src')) cliSourceRootChecks++
    return exists(file)
  }
  const list = (dir: string) => (dir === '/repo' ? ['cli'] : [])
  // moduleRoot IS 'cli' here, so it must not be searched again as a "sibling".
  resolveJacocoPath('/repo/cli', 'io/kestra/cli', 'Foo.java', '/repo', countingExists, list)
  const SOURCE_ROOT_COUNT = 10
  assert.equal(cliSourceRootChecks, SOURCE_ROOT_COUNT, 'cli should only be tried once, as moduleRoot, not again as a sibling')
})

test('resolveJacocoPath falls back to the guess when no sibling module has the source either', () => {
  const files = new Set(['/repo/build.gradle', '/repo/cli/build.gradle'])
  const exists = (file: string) => files.has(file)
  const list = (dir: string) => (dir === '/repo' ? ['cli'] : [])
  assert.equal(resolveJacocoPath('/repo', 'io/kestra/cli', 'Foo.java', '/repo', exists, list), 'io/kestra/cli/Foo.java')
})

test('parseJacoco reads line, branch and method counters per source file', () => {
  const files = new Set(['/repo/core/src/main/java/io/kestra/core/Foo.java', '/repo/core/build.gradle.kts'])
  const exists = (file: string) => files.has(file)
  const parsed = parseJacoco(FIXTURE, '/repo/core/build/reports/jacoco/test/jacocoTestReport.xml', '/repo', exists)
  assert.deepEqual(parsed, [
    {
      path: 'core/src/main/java/io/kestra/core/Foo.java',
      format: 'jacoco',
      lines: { covered: 7, missed: 3 },
      branches: { covered: 1, missed: 1 },
      functions: { covered: 2, missed: 1 }
    }
  ])
})

test('parseJacoco yields nothing when there is no <report> root', () => {
  assert.deepEqual(parseJacoco('<not-a-report/>', '/repo/report.xml', '/repo'), [])
})

test('parseJacoco resolves the right module from a root-level aggregate report', () => {
  const files = new Set(['/repo/build.gradle', '/repo/core/build.gradle', '/repo/core/src/main/java/io/kestra/core/Foo.java'])
  const exists = (file: string) => files.has(file)
  const list = (dir: string) => (dir === '/repo' ? ['core'] : [])
  // The aggregate lives at the repo root, not under core/ — findModuleRoot alone would attribute
  // this package to the repository root module, which is exactly the bug this fixes.
  const parsed = parseJacoco(FIXTURE, '/repo/build/reports/jacoco/testCodeCoverageReport/testCodeCoverageReport.xml', '/repo', exists, list)
  assert.equal(parsed[0]?.path, 'core/src/main/java/io/kestra/core/Foo.java')
})
