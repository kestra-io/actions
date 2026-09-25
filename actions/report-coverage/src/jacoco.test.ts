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
  assert.equal(resolveJacocoPath('/repo/core', 'io/kestra/core', 'Foo.java', '/repo', exists), 'core/src/main/java/io/kestra/core/Foo.java')
})

test('resolveJacocoPath falls back to <module>/<package>/<file> when nothing exists on disk', () => {
  assert.equal(resolveJacocoPath('/repo/core', 'io/kestra/core', 'Foo.java', '/repo', () => false), 'core/io/kestra/core/Foo.java')
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
