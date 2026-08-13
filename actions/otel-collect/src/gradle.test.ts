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
    // Same host/workflow resource attributes as buildResource() (otlp.ts) and the
    // hostmetrics collector (collector.ts), so Gradle/JUnit spans aren't the only
    // ones missing host.name / github.* in a trace backend.
    assert.match(script, /def hostName = System\.getenv\("RUNNER_NAME"\) \?: ""/)
    assert.match(script, /def workflowName = System\.getenv\("GITHUB_WORKFLOW"\) \?: ""/)
    assert.match(script, /def sha = System\.getenv\("GITHUB_SHA"\) \?: ""/)
    assert.match(script, /def ref = System\.getenv\("GITHUB_REF"\) \?: ""/)
    assert.match(script, /def runnerEnvironment = System\.getenv\("RUNNER_ENVIRONMENT"\) \?: ""/)
    assert.match(script, /put\("host\.name", hostName\)/)
    assert.match(script, /put\("github\.workflow\.name", workflowName\)/)
    assert.match(script, /put\("github\.run_id", runId \?: ""\)/)
    assert.match(script, /put\("github\.run_attempt", runAttempt\)/)
    assert.match(script, /put\("github\.sha", sha\)/)
    assert.match(script, /put\("github\.ref", ref\)/)
    assert.match(script, /put\("github\.runner_environment", runnerEnvironment\)/)
  } finally {
    if (prev === undefined) delete process.env.GRADLE_USER_HOME
    else process.env.GRADLE_USER_HOME = prev
    fs.rmSync(gradleUserHome, { recursive: true, force: true })
  }
})

test('installGradleInitScript embeds a job-scoped instance id when given a job id, else falls back to run-level', () => {
  const gradleUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-collect-gradle-'))
  const prev = process.env.GRADLE_USER_HOME
  process.env.GRADLE_USER_HOME = gradleUserHome
  try {
    const withJob = fs.readFileSync(installGradleInitScript('svc', 789), 'utf8')
    assert.match(withJob, /def jobId = "789"/)
    assert.match(
      withJob,
      /"Workflow " \+ runId \+ " - Job " \+ jobId \+ " - Attempt " \+ runAttempt/
    )

    const withoutJob = fs.readFileSync(installGradleInitScript('svc'), 'utf8')
    assert.match(withoutJob, /def jobId = null/)
  } finally {
    if (prev === undefined) delete process.env.GRADLE_USER_HOME
    else process.env.GRADLE_USER_HOME = prev
    fs.rmSync(gradleUserHome, { recursive: true, force: true })
  }
})
