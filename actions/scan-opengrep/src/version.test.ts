import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assetNameFor,
  DEFAULT_IGNORED_FINDINGS,
  DEFAULT_RULESETS,
  KNOWN_PACKS,
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

test('the default ruleset is a registry pack', () => {
  assert.match(DEFAULT_RULESETS, /^p\//)
})

test('every known pack is p/ prefixed, so the bare-word sugar cannot collide with a path', () => {
  for (const pack of KNOWN_PACKS) assert.match(pack, /^p\/[a-z0-9-]+$/)
})

test('the registry host is recorded, since a scan depends on reaching it', () => {
  assert.equal(REGISTRY_HOST, 'semgrep.dev')
})

test('the mutable-action-tag default is scoped to kestra-io/actions, not the whole rule', () => {
  const ignore = DEFAULT_IGNORED_FINDINGS.find(entry => entry.rule === 'github-actions-mutable-action-tag')
  assert.ok(ignore, 'expected a default suppression for the mutable action tag rule')
  assert.equal(ignore.match, 'kestra-io/actions/')
  assert.ok(ignore.reason)
})
