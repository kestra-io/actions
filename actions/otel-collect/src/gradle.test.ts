import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { installGradleInitScript } from './gradle.js'

test('installGradleInitScript derives distinct " - Gradle" / " - JUnit" service names, tagged by telemetry.source', () => {
  const gradleUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-collect-gradle-'))
  const prev = process.env.GRADLE_USER_HOME
  process.env.GRADLE_USER_HOME = gradleUserHome
  try {
    const scriptPath = installGradleInitScript('github-actions-org/repo')
    const script = fs.readFileSync(scriptPath, 'utf8')

    assert.match(script, /makeTracerProvider\("github-actions-org\/repo - Gradle"\)/)
    assert.match(script, /makeTracerProvider\("github-actions-org\/repo - JUnit"\)/)
    assert.match(script, /setAttribute\("telemetry\.source", "gradle"\)/)
    assert.match(script, /setAttribute\("telemetry\.source", "junit"\)/)
    // one exporter/provider per layer, both flushed and shut down
    assert.match(script, /\[gradleTracerProvider, junitTracerProvider\]\.each/)
    // vcs.repository.name is forwarded onto both layers' resources
    assert.match(script, /def repositoryName = System\.getenv\("GITHUB_REPOSITORY"\) \?: ""/)
    assert.match(script, /put\("vcs\.repository\.name", repositoryName\)/)
  } finally {
    if (prev === undefined) delete process.env.GRADLE_USER_HOME
    else process.env.GRADLE_USER_HOME = prev
    fs.rmSync(gradleUserHome, { recursive: true, force: true })
  }
})
