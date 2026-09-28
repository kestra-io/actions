import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectModule, ROOT_MODULE, type ModuleDetector } from './modules.js'

function detector(buildFiles: string[]): ModuleDetector {
  return { exists: file => buildFiles.includes(file), list: () => [] }
}

test('detectModule prefers an explicit override', () => {
  const module = detectModule('lib/core/src/Foo.java', '/repo', { core: 'lib/core' }, detector([]))
  assert.equal(module, 'core')
})

test('detectModule climbs to the nearest ancestor with a build file', () => {
  const module = detectModule('plugin-x/src/main/java/Foo.java', '/repo', {}, detector(['/repo/plugin-x/build.gradle.kts']))
  assert.equal(module, 'plugin-x')
})

test('detectModule falls back to the repository root when no build file is found', () => {
  assert.equal(detectModule('src/Foo.ts', '/repo', {}, detector([])), ROOT_MODULE)
})

test('detectModule finds a .csproj via directory listing', () => {
  const module = detectModule('Api/Program.cs', '/repo', {}, { exists: () => false, list: dir => (dir === '/repo/Api' ? ['Api.csproj'] : []) })
  assert.equal(module, 'Api')
})
