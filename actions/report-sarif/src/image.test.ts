import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubMetadata } from '../../../shared/elastic-core/src/github.js'
import { findingId, imageShortName, parseImageRef, scanSummary, toDocument, type DocumentContext } from './documents.js'
import { flattenTrivy, imageDigest, unfixedOsCount, type TrivyReport } from './trivy.js'

// Trimmed from a real `trivy image --format json docker.io/kestra/kestra:latest` run (2026-10-27).
const report: TrivyReport = {
  SchemaVersion: 2,
  ArtifactName: 'docker.io/kestra/kestra:latest',
  ArtifactType: 'container_image',
  Trivy: { Version: '0.72.0' },
  Metadata: {
    OS: { Family: 'ubuntu', Name: '24.04' },
    RepoTags: ['kestra/kestra:latest'],
    RepoDigests: ['kestra/kestra@sha256:ad7602269219ab969e8194a6000e139ad5d5e153556435afb8d2a35a19993ccd']
  },
  Results: [
    {
      Target: 'docker.io/kestra/kestra:latest (ubuntu 24.04)',
      Class: 'os-pkgs',
      Type: 'ubuntu',
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-2026-102473', PkgName: 'dash', InstalledVersion: '0.5.12-6ubuntu5', Severity: 'MEDIUM', Status: 'affected', Title: 'dash: backtracking' },
        { VulnerabilityID: 'CVE-2025-6020', PkgName: 'libpam0g', InstalledVersion: '1.5.3-5ubuntu5.1', FixedVersion: '1.5.3-5ubuntu5.4', Severity: 'HIGH', Status: 'fixed', Title: 'pam: path traversal' }
      ]
    },
    {
      Target: 'Java',
      Class: 'lang-pkgs',
      Type: 'jar',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2026-8763',
          PkgName: 'org.bouncycastle:bcprov-jdk18on',
          PkgPath: 'app/plugins/io_kestra_plugin__plugin-pulsar__1_6_2.jar/lib/bcprov-jdk18on-1.84.jar',
          PkgIdentifier: { PURL: 'pkg:maven/org.bouncycastle/bcprov-jdk18on@1.84' },
          InstalledVersion: '1.84',
          FixedVersion: '1.85',
          Status: 'fixed',
          Severity: 'CRITICAL',
          Title: 'bouncycastle: something bad'
        },
        { VulnerabilityID: 'CVE-2026-1', PkgName: 'org.example:unfixed', InstalledVersion: '1.0', Severity: 'LOW', Title: 'no fix yet' }
      ]
    }
  ]
}

function context(digest?: string, tag = 'latest'): DocumentContext {
  return {
    dataset: '',
    namespace: 'gha',
    type: 'vulnerabilities',
    image: { name: 'docker.io/kestra/kestra', tag, digest },
    github: githubMetadata({
      GITHUB_REPOSITORY: 'kestra-io/actions',
      GITHUB_REPOSITORY_OWNER: 'kestra-io',
      GITHUB_RUN_ID: '42',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'deadbeef',
      GITHUB_ACTOR: 'kestra-bot'
    }),
    scanTime: '2026-10-28T06:00:00.000Z',
    tags: [],
    metadata: { component: 'image' }
  }
}

test('parses an image reference', () => {
  assert.deepEqual(parseImageRef('docker.io/kestra/kestra:latest'), { name: 'docker.io/kestra/kestra', tag: 'latest', digest: undefined })
  assert.deepEqual(parseImageRef('ghcr.io/kestra-io/pydata'), { name: 'ghcr.io/kestra-io/pydata', tag: 'latest', digest: undefined })
  assert.deepEqual(parseImageRef('localhost:5000/x'), { name: 'localhost:5000/x', tag: 'latest', digest: undefined }, 'a registry port is not a tag')
  assert.deepEqual(parseImageRef('kestra/kestra@sha256:abc'), { name: 'kestra/kestra', tag: 'sha256:abc', digest: 'sha256:abc' })
  assert.equal(imageShortName(parseImageRef('docker.io/kestra/kestra:v1.3')), 'kestra')
  assert.equal(imageDigest(report), 'sha256:ad7602269219ab969e8194a6000e139ad5d5e153556435afb8d2a35a19993ccd')
})

test('unfixed OS package vulnerabilities are left out of an image scan, language ones kept', () => {
  assert.equal(unfixedOsCount(report), 1)
  const all = flattenTrivy(report)
  assert.equal(all.length, 4)
  const kept = flattenTrivy(report, { dropUnfixedOs: true })
  assert.deepEqual(kept.map(finding => finding.ruleId), ['CVE-2025-6020', 'CVE-2026-8763', 'CVE-2026-1'])
  assert.equal(kept[1].packagePath, 'app/plugins/io_kestra_plugin__plugin-pulsar__1_6_2.jar/lib/bcprov-jdk18on-1.84.jar')
  assert.equal(kept[1].ecosystem, 'jar')
  assert.equal(kept[0].resultClass, 'os-pkgs')
})

test('an image finding is on the image, not on the workflow repository', () => {
  const digest = imageDigest(report)
  const [os, java] = flattenTrivy(report, { dropUnfixedOs: true })
  const document = toDocument(java, context(digest)) as Record<string, Record<string, unknown>>
  assert.deepEqual(document.resource, {
    id: document.resource.id,
    name: 'docker.io/kestra/kestra (latest) / Java',
    type: 'container-image',
    sub_type: 'jar',
    target: 'jar',
    language: 'jar',
    repository: 'docker.io/kestra/kestra',
    url: 'https://docker.io/kestra/kestra'
  })
  assert.equal(String(document.resource.id).length, 32)
  assert.deepEqual(document.container, { image: { name: 'docker.io/kestra/kestra', tag: ['latest'], hash: { all: [digest] } } })
  assert.deepEqual(document.service, { name: 'kestra' })
  assert.deepEqual(document.labels, { component: 'image' })
  assert.equal(document.package.path, 'app/plugins/io_kestra_plugin__plugin-pulsar__1_6_2.jar/lib/bcprov-jdk18on-1.84.jar')
  assert.equal(document.package.name, 'org.bouncycastle:bcprov-jdk18on')
  assert.equal(document.vulnerability.id, 'CVE-2026-8763')
  assert.equal(document.vulnerability.severity, 'Critical')
  assert.equal(document.github.repository, 'kestra-io/actions', 'the workflow context stays what it is')
  assert.equal(document.url, undefined)
  const osDocument = toDocument(os, context(digest)) as Record<string, Record<string, unknown>>
  assert.equal(osDocument.resource.sub_type, 'ubuntu')
  assert.equal(osDocument.resource.name, 'docker.io/kestra/kestra (latest) / ubuntu 24.04')
  assert.notEqual(osDocument.resource.id, document.resource.id, 'one resource per result type')
})

test('metadata service.name beats the image default', () => {
  const [, java] = flattenTrivy(report, { dropUnfixedOs: true })
  const document = toDocument(java, { ...context(), metadata: { 'service.name': 'kestra-oss', component: 'image' } }) as Record<string, Record<string, unknown>>
  assert.deepEqual(document.service, { name: 'kestra-oss' })
})

test('the finding id follows the tag, not the digest', () => {
  const [, java] = flattenTrivy(report, { dropUnfixedOs: true })
  const a = findingId(java, context('sha256:aaaa'))
  const b = findingId(java, context('sha256:bbbb'))
  assert.equal(a, b, 'latest moving to a new build keeps the same finding')
  assert.notEqual(a, findingId(java, context('sha256:aaaa', 'v1.3')), 'each tag has its own finding')
  assert.notEqual(a, findingId({ ...java, packageName: 'other' }, context('sha256:aaaa')))
})

test('a scan summary is shipped per image, with no resource sub type', () => {
  const summary = scanSummary(context(imageDigest(report)), 'Trivy', '0.72.0', 0) as Record<string, Record<string, unknown>>
  assert.equal(summary.event.action, 'scan_completed')
  assert.equal(summary.event.outcome, 'success')
  assert.equal(summary.event.sequence, 42)
  assert.deepEqual(summary.event.category, ['vulnerability'])
  assert.equal(summary.message, 'Trivy scanned docker.io/kestra/kestra:latest: 0 vulnerabilities')
  assert.deepEqual(summary.data_stream, { type: 'logs', dataset: 'trivy', namespace: 'gha' })
  assert.equal(summary.resource.type, 'container-image')
  assert.equal(summary.resource.repository, 'docker.io/kestra/kestra')
  assert.equal(summary.resource.sub_type, undefined)
  assert.deepEqual(summary.labels, { component: 'image' })
  assert.equal((summary.container.image as Record<string, unknown>).name, 'docker.io/kestra/kestra')
  assert.deepEqual(summary.vulnerability.scanner, { vendor: 'Trivy', version: '0.72.0' })
  assert.equal(summary.vulnerability.id, undefined, 'not a finding')
})

test('without an image the repository shape is unchanged', () => {
  const [, java] = flattenTrivy(report)
  const document = toDocument(java, { ...context(), image: undefined }) as Record<string, Record<string, unknown>>
  assert.equal(document.resource.type, 'github-repository')
  assert.equal(document.resource.repository, 'kestra-io/actions')
  assert.equal(document.container, undefined)
  assert.equal(document.service, undefined)
})
