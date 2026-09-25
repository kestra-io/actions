import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findingId, setPath, toDocument, type DocumentContext } from './documents.js'
import { githubMetadata } from './github.js'
import type { Finding } from './finding.js'

const context: DocumentContext = {
  dataset: 'security_scan.findings',
  namespace: 'github-actions',
  github: githubMetadata({
    GITHUB_REPOSITORY: 'kestra-io/kestra',
    GITHUB_REPOSITORY_OWNER: 'kestra-io',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SHA: 'deadbeef',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW: 'Main',
    GITHUB_ACTOR: 'dependabot[bot]',
    GITHUB_TRIGGERING_ACTOR: 'tchiotludo',
    GITHUB_ACTOR_ID: '2064609'
  }),
  scanTime: '2026-09-24T10:00:00.000Z',
  tags: ['ci'],
  metadata: { team: 'security', 'service.name': 'kestra-ee' }
}

const finding: Finding = {
  tool: 'Trivy',
  toolVersion: '0.58.1',
  ruleId: 'CVE-2024-1234',
  ruleName: 'OsPackageVulnerability',
  level: 'error',
  severity: 'Critical',
  score: 9.8,
  scoreVersion: '3.1',
  title: 'Buffer overflow',
  description: 'A buffer overflow in openssl.',
  helpUri: 'https://avd.aquasec.com/nvd/cve-2024-1234',
  tags: ['Critical'],
  cwes: ['CWE-120'],
  file: 'build/libs/plugin.jar',
  startLine: 1,
  packageName: 'openssl',
  packageVersion: '1.1.1',
  packageFixedVersion: '1.1.1n'
}

test('maps a vulnerability onto ECS fields', () => {
  const document = toDocument(finding, context) as Record<string, Record<string, unknown>>
  assert.equal(document['@timestamp'], '2026-09-24T10:00:00.000Z')
  assert.equal(document.vulnerability.id, 'CVE-2024-1234')
  assert.equal(document.vulnerability.severity, 'Critical')
  assert.equal(document.vulnerability.enumeration, 'CVE')
  assert.deepEqual(document.vulnerability.score, { base: 9.8, version: '3.1' })
  assert.deepEqual(document.vulnerability.scanner, { vendor: 'Trivy', version: '0.58.1' })
  assert.deepEqual(document.package, { name: 'openssl', version: '1.1.1', fixed_version: '1.1.1n' })
  assert.equal(document.event.kind, 'event')
  assert.deepEqual(document.event.category, ['vulnerability'])
  assert.deepEqual(document.data_stream, { type: 'logs', dataset: 'security_scan.findings', namespace: 'github-actions' })
  assert.equal(document.resource.name, 'kestra-io/kestra')
  assert.deepEqual(document.user, { name: 'tchiotludo', id: '2064609' })
  assert.equal(document.url, undefined, 'a package vulnerability points at a build artifact, not a tracked file')
})

test('metadata goes to its dotted path, or to labels when undotted', () => {
  const document = toDocument(finding, context) as Record<string, Record<string, unknown>>
  assert.deepEqual(document.labels, { team: 'security' })
  assert.equal(document.service.name, 'kestra-ee')
})

test('a static analysis finding carries no package and is not flagged as a CVE', () => {
  const code: Finding = {
    ...finding,
    ruleId: 'java.lang.security.audit.unsafe-reflection',
    score: undefined,
    packageName: undefined,
    packageVersion: undefined,
    packageFixedVersion: undefined
  }
  const document = toDocument(code, context) as Record<string, Record<string, unknown>>
  assert.equal(document.package, undefined)
  assert.equal(document.url.full, 'https://github.com/kestra-io/kestra/blob/deadbeef/build/libs/plugin.jar#L1')
  assert.equal(document.vulnerability.enumeration, undefined)
  assert.equal(document.vulnerability.classification, undefined)
  assert.equal(document.vulnerability.category, 'Static Analysis')
})

test('the finding id is stable across runs but distinct per location', () => {
  const other: DocumentContext = {
    ...context,
    github: { ...context.github, runId: '99', sha: 'cafe' },
    scanTime: '2027-01-01T00:00:00.000Z'
  }
  assert.equal(findingId(finding, context), findingId(finding, other))
  assert.notEqual(findingId(finding, context), findingId({ ...finding, startLine: 2 }, context))
  assert.notEqual(findingId(finding, context), findingId({ ...finding, file: 'other.jar' }, context))
})

test('setPath builds nested objects and overwrites a non-object on the way', () => {
  const target: Record<string, unknown> = { a: 'scalar' }
  setPath(target, 'a.b.c', 1)
  assert.deepEqual(target, { a: { b: { c: 1 } } })
})

test('empty values are pruned rather than indexed as empty strings', () => {
  const bare: Finding = {
    tool: 'x',
    toolVersion: '',
    ruleId: 'r',
    ruleName: '',
    level: 'none',
    severity: 'Unknown',
    title: 'T',
    description: '',
    tags: [],
    cwes: []
  }
  const document = toDocument(bare, { ...context, tags: [], metadata: {} }) as Record<string, Record<string, unknown>>
  assert.equal(document.file, undefined)
  assert.equal(document.log, undefined)
  assert.equal(document.url, undefined)
  assert.equal(document.tags, undefined)
  assert.equal(document.vulnerability.cwe, undefined)
  assert.equal(document.observer.version, undefined)
})

test('the run context lands under one github namespace, with nothing above it', () => {
  const document = toDocument(finding, context) as Record<string, Record<string, unknown>>
  assert.equal(document.vcs, undefined, 'superseded by github.*')
  assert.equal(document.github.repository, 'kestra-io/kestra')
  assert.equal(document.github.sha, 'deadbeef')
  assert.equal(document.github.runId, '42')
  assert.equal(document.github.runAttempt, 2)
  assert.equal(document.github.runUrl, 'https://github.com/kestra-io/kestra/actions/runs/42/attempts/2')
  assert.equal(document.vulnerability.report_id, '42-2')
})

test('the github namespace is a copy, so pruning one document cannot empty the next', () => {
  const first = toDocument(finding, context) as Record<string, Record<string, unknown>>
  const second = toDocument(finding, context) as Record<string, Record<string, unknown>>
  assert.notEqual(first.github, second.github)
  assert.deepEqual(first.github, second.github)
  assert.equal(context.github.refName, '', 'the source metadata is left untouched')
})

test('our own namespaces are camelCase, ECS keeps its canonical names', () => {
  const document = toDocument(finding, context) as Record<string, Record<string, unknown>>
  const withRegion = toDocument({ ...finding, startColumn: 9, endLine: 4 }, context) as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(withRegion.sarif), ['level', 'ruleId', 'ruleName', 'startLine', 'startColumn', 'endLine'])
  assert.deepEqual(Object.keys(document.github).filter(key => key.includes('_')), [])
  assert.equal(document.github.repositoryOwner, 'kestra-io')
  // Renaming these would take the finding out of the Elastic security views that read them.
  assert.ok('fixed_version' in document.package)
  assert.ok('report_id' in document.vulnerability)
  assert.ok('data_stream' in document)
})

test('an advisory id fills cve and enumeration, a rule id fills neither', () => {
  const ghsa = toDocument({ ...finding, ruleId: 'GHSA-537c-gmf6-5ccf' }, context) as Record<string, Record<string, unknown>>
  assert.equal(ghsa.vulnerability.enumeration, 'GHSA')
  assert.equal(ghsa.vulnerability.cve, undefined, 'a GHSA-only advisory has no CVE assigned')
  assert.equal(ghsa.vulnerability.id, 'GHSA-537c-gmf6-5ccf', 'the id is always there to fall back on')

  const cve = toDocument(finding, context) as Record<string, Record<string, unknown>>
  assert.equal(cve.vulnerability.enumeration, 'CVE')
  assert.equal(cve.vulnerability.cve, 'CVE-2024-1234')

  const sast = toDocument({ ...finding, ruleId: 'java.lang.security.audit.unsafe-reflection' }, context) as Record<
    string,
    Record<string, unknown>
  >
  assert.equal(sast.vulnerability.enumeration, undefined)
  assert.equal(sast.vulnerability.cve, undefined)
})

test('event.severity is a sortable band, set even when no CVSS score arrived', () => {
  const bands: [string, number][] = [
    ['Critical', 99],
    ['High', 73],
    ['Medium', 47],
    ['Low', 21],
    ['Unknown', 0]
  ]
  for (const [severity, expected] of bands) {
    const document = toDocument({ ...finding, severity, score: undefined } as Finding, context) as Record<
      string,
      Record<string, unknown>
    >
    assert.equal(document.event.severity, expected, severity)
    assert.equal(document.vulnerability.score, undefined)
    assert.equal(document.vulnerability.classification, undefined, 'no score means no scoring system to name')
  }
})

test('the github owner is mirrored into ECS organization', () => {
  const document = toDocument(finding, context) as Record<string, Record<string, unknown>>
  assert.deepEqual(document.organization, { name: 'kestra-io' })
})
