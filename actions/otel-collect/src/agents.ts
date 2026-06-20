import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'

const JAVA_RELEASES = 'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases'

/**
 * Download & cache the OpenTelemetry Java agent jar. Auto-injects it via
 * JAVA_TOOL_OPTIONS so every JVM in the job (gradle daemon + forked JUnit) is
 * instrumented. Returns the jar path.
 */
export async function setupJavaAgent(version: string): Promise<string> {
  const cacheVersion = version === 'latest' ? 'latest' : version
  let dir = tc.find('opentelemetry-javaagent', cacheVersion)
  let jar = dir ? path.join(dir, 'opentelemetry-javaagent.jar') : ''

  if (!jar || !fs.existsSync(jar)) {
    const url =
      version === 'latest'
        ? `${JAVA_RELEASES}/latest/download/opentelemetry-javaagent.jar`
        : `${JAVA_RELEASES}/download/v${version}/opentelemetry-javaagent.jar`
    core.info(`Downloading opentelemetry-javaagent from ${url}`)
    const downloaded = await tc.downloadTool(url)
    dir = await tc.cacheFile(downloaded, 'opentelemetry-javaagent.jar', 'opentelemetry-javaagent', cacheVersion)
    jar = path.join(dir, 'opentelemetry-javaagent.jar')
  }

  const existing = process.env.JAVA_TOOL_OPTIONS ?? ''
  const flag = `-javaagent:${jar}`
  if (!existing.includes(flag)) {
    core.exportVariable('JAVA_TOOL_OPTIONS', existing ? `${existing} ${flag}` : flag)
  }
  core.info(`Java agent ready: ${jar}`)
  return jar
}

/**
 * Install & cache the Node auto-instrumentation and auto-inject it via
 * NODE_OPTIONS. Returns the path to the `register` module.
 */
export async function setupNodeAgent(): Promise<string> {
  const pkg = '@opentelemetry/auto-instrumentations-node'
  const version = '0.55.0'

  let dir = tc.find('otel-node-instrumentation', version)
  if (!dir) {
    const tmp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp'
    const installDir = path.join(tmp, 'otel-node-instrumentation')
    fs.mkdirSync(installDir, { recursive: true })
    fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'otel-node-bootstrap', private: true }))
    await exec.exec('npm', ['install', '--no-audit', '--no-fund', `${pkg}@${version}`], { cwd: installDir })
    dir = await tc.cacheDir(installDir, 'otel-node-instrumentation', version)
  }

  // Resolve via the package's `./register` export map rather than guessing the
  // internal file path. Make the bare specifier resolvable by adding our cached
  // install dir to NODE_PATH.
  const modulesDir = path.join(dir, 'node_modules')
  const registerSpecifier = `${pkg}/register`

  const existingNodePath = process.env.NODE_PATH ?? ''
  if (!existingNodePath.split(path.delimiter).includes(modulesDir)) {
    core.exportVariable('NODE_PATH', existingNodePath ? `${modulesDir}${path.delimiter}${existingNodePath}` : modulesDir)
  }

  const existing = process.env.NODE_OPTIONS ?? ''
  const flag = `--require ${registerSpecifier}`
  if (!existing.includes(registerSpecifier)) {
    core.exportVariable('NODE_OPTIONS', existing ? `${existing} ${flag}` : flag)
  }
  core.info(`Node auto-instrumentation ready: ${registerSpecifier} (NODE_PATH=${modulesDir})`)
  return path.join(modulesDir, pkg, 'register.js')
}
