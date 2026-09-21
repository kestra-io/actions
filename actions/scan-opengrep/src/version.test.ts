import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as versionModule from './version.js'
import {
  assetNameFor,
  REGISTRY_HOST,
  releaseApiUrl,
  selectAsset
} from './version.js'

const release = (digest?: string | null) => ({
  tag_name: 'v1.30.0',
  assets: [
    { name: 'opengrep_manylinux_x86', browser_download_url: 'https://example/x86', digest: digest },
    { name: 'opengrep_manylinux_aarch64', browser_download_url: 'https://example/arm', digest: 'sha256:bbb' }
  ]
})

test('assetNameFor picks the manylinux build matching the runner architecture', () => {
  assert.equal(assetNameFor('X64'), 'opengrep_manylinux_x86')
  assert.equal(assetNameFor('ARM64'), 'opengrep_manylinux_aarch64')
})

test('assetNameFor refuses an unsupported architecture instead of guessing', () => {
  assert.throws(() => assetNameFor('X86'), /Unsupported runner architecture 'X86'/)
})

test('releaseApiUrl asks for the latest release when version is latest', () => {
  assert.match(releaseApiUrl('latest'), /releases\/latest$/)
})

test('releaseApiUrl pins to a tag, adding the v prefix when it is missing', () => {
  assert.match(releaseApiUrl('1.30.0'), /releases\/tags\/v1\.30\.0$/)
  assert.match(releaseApiUrl('v1.30.0'), /releases\/tags\/v1\.30\.0$/)
})

test('selectAsset resolves the concrete tag and version, never the literal "latest"', () => {
  const resolved = selectAsset(release('sha256:aaa'), 'X64')
  assert.equal(resolved.tag, 'v1.30.0')
  assert.equal(resolved.version, '1.30.0')
  assert.equal(resolved.assetUrl, 'https://example/x86')
})

test('selectAsset strips the sha256: prefix the API uses', () => {
  assert.equal(selectAsset(release('sha256:aaa'), 'X64').sha256, 'aaa')
})

test('selectAsset reports no checksum rather than inventing one', () => {
  assert.equal(selectAsset(release(null), 'X64').sha256, null)
  assert.equal(selectAsset(release(undefined), 'X64').sha256, null)
})

test('selectAsset fails loudly when the release has no asset for this architecture', () => {
  assert.throws(() => selectAsset({ tag_name: 'v1.30.0', assets: [] }, 'X64'), /has no asset named/)
})

test('the action holds no scan settings; those come from .opengrep/config.yml', () => {
  for (const name of ['DEFAULT_RULESETS', 'DEFAULT_EXCLUDED_PATHS', 'DEFAULT_IGNORED_FINDINGS', 'KNOWN_PACKS']) {
    assert.equal(name in versionModule, false, `${name} should not be hardcoded in the action`)
  }
})

test('the registry host is recorded, since a scan depends on reaching it', () => {
  assert.equal(REGISTRY_HOST, 'semgrep.dev')
})

test('the action ships no built-in suppressions; they come from .opengrep/config.yml', () => {
  assert.equal('DEFAULT_IGNORED_FINDINGS' in versionModule, false)
})
