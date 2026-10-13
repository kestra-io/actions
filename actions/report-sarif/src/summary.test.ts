import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubMetadata } from '../../../shared/elastic-core/src/github.js'
import { toDocument, type DocumentContext } from './documents.js'
import type { Finding } from './finding.js'
import { buildSummaries, parseOutcome } from './summary.js'

const github = githubMetadata({
  GITHUB_REPOSITORY: 'kestra-io/kestra-ee',
  GITHUB_REPOSITORY_OWNER: 'kestra-io',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'deadbeef',
  GITHUB_REF: 'refs/heads/develop',
  GITHUB_REF_NAME: 'develop',
  GITHUB_WORKFLOW: 'Main'
})

const vulnerabilities: DocumentContext = {
  dataset: '',
  namespace: 'gha',
  type: 'vulnerabilities',
  github,
  scanTime: '2026-10-09T10:00:00.000Z',
  tags: [],
  metadata: { 'service.name': 'kestra-ee', component: 'frontend', target: 'ui-dependencies' }
}

const misconfigurations: DocumentContext = { ...vulnerabilities, type: 'misconfigurations', metadata: { component: 'backend' } }

const cve: Finding = {
  tool: 'Trivy',
  toolVersion: '0.70.0',
  ruleId: 'CVE-2024-1234',
  ruleName: 'lang-pkgs',
  level: 'error',
  severity: 'High',
  title: 'Prototype pollution',
  description: '',
  tags: [],
  cwes: [],
  file: 'package-lock.json',
  packageName: 'lodash'
}

const secret: Finding = {
  tool: 'TruffleHog',
  toolVersion: '',
  ruleId: 'AWS',
  ruleName: 'AWS',
  level: 'error',
  severity: 'Critical',
  title: 'AWS secret (verified)',
  description: '',
  tags: [],
  cwes: [],
  file: 'src/config.yml',
  startLine: 3
}

type Doc = Record<string, Record<string, unknown>>

test('parseOutcome maps GitHub step outcomes', () => {
  assert.equal(parseOutcome(''), 'success')
  assert.equal(parseOutcome('success'), 'success')
  assert.equal(parseOutcome('failure'), 'failure')
  assert.equal(parseOutcome('cancelled'), 'failure')
  assert.equal(parseOutcome('nonsense'), undefined)
})

test('a clean branch-scoped scan still ships one summary, with the step metadata', () => {
  const [summary, ...rest] = buildSummaries(
    { findings: [], scans: [], scanner: 'TruffleHog', outcome: 'success' },
    misconfigurations
  ) as Doc[]
  assert.equal(rest.length, 0)
  assert.equal(summary['@timestamp'], '2026-10-09T10:00:00.000Z')
  assert.deepEqual(summary.data_stream, { type: 'logs', dataset: 'trufflehog', namespace: 'gha' })
  assert.equal(summary.event.kind, 'event')
  assert.equal(summary.event.action, 'scan_completed')
  assert.equal(summary.event.outcome, 'success')
  assert.equal(summary.event.sequence, 42)
  assert.deepEqual(summary.scan, { scope: 'branch', type: 'misconfigurations', findings_count: 0 })
  assert.deepEqual(summary.observer, { vendor: 'TruffleHog', product: 'TruffleHog' })
  assert.equal(summary.resource.repository, 'kestra-io/kestra-ee')
  assert.equal(summary.resource.name, 'kestra-io/kestra-ee (develop)')
  assert.equal(summary.github.refName, 'develop')
  assert.equal(summary.github.runId, '42')
  assert.equal(summary.labels.component, 'backend')
})

test('a summary never looks like a finding', () => {
  const [summary] = buildSummaries({ findings: [secret], scans: [], scanner: 'TruffleHog', outcome: 'success' }, misconfigurations) as Doc[]
  assert.equal(summary.event.id, undefined, 'no event.id for a latest transform to key on')
  assert.equal(summary.event.category, undefined)
  assert.equal(summary.rule, undefined)
  assert.equal(summary.vulnerability, undefined)
  assert.equal(summary.result, undefined)
  assert.equal(summary.scan.findings_count, 1)
})

test('the summary shares the findings timestamp and stream', () => {
  const finding = toDocument(secret, misconfigurations) as Doc
  const [summary] = buildSummaries({ findings: [secret], scans: [], scanner: '', outcome: 'success' }, misconfigurations) as Doc[]
  assert.equal(summary['@timestamp'], finding['@timestamp'])
  assert.deepEqual(summary.data_stream, finding.data_stream)
  assert.deepEqual(summary.labels, finding.labels)
})

test('Trivy gets one summary per target, joined to its findings by resource.id', () => {
  const summaries = buildSummaries(
    {
      findings: [cve],
      scans: [{ tool: 'Trivy', toolVersion: '0.70.0', targets: ['package-lock.json', 'yarn.lock'], artifact: './ui' }],
      scanner: 'Trivy',
      outcome: 'success'
    },
    vulnerabilities
  ) as Doc[]
  assert.equal(summaries.length, 2)
  const finding = toDocument(cve, vulnerabilities) as Doc
  const [dirty, clean] = summaries
  assert.equal(dirty.resource.id, finding.resource.id)
  assert.equal(dirty.resource.name, 'kestra-io/kestra-ee (develop) / package-lock.json')
  assert.deepEqual(dirty.scan, { scope: 'target', type: 'vulnerabilities', artifact: './ui', findings_count: 1 })
  assert.equal(clean.resource.name, 'kestra-io/kestra-ee (develop) / yarn.lock')
  assert.equal(clean.scan.findings_count, 0)
  assert.equal(clean.labels.target, 'ui-dependencies')
  assert.equal(clean.observer.version, '0.70.0')
})

test('Trivy with no target at all is scoped to the artifact', () => {
  const [summary] = buildSummaries(
    { findings: [], scans: [{ tool: 'Trivy', toolVersion: '0.70.0', targets: [], artifact: 'build/sbom/java.json' }], scanner: 'Trivy', outcome: 'success' },
    vulnerabilities
  ) as Doc[]
  assert.deepEqual(summary.scan, { scope: 'artifact', type: 'vulnerabilities', artifact: 'build/sbom/java.json', findings_count: 0 })
})

test('a failed scan says so and claims no count', () => {
  const summaries = buildSummaries({ findings: [], scans: [], scanner: 'Opengrep', outcome: 'failure' }, misconfigurations) as Doc[]
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].event.outcome, 'failure')
  assert.equal(summaries[0].scan.findings_count, undefined)
  assert.equal(summaries[0].data_stream.dataset, 'opengrep')
})

test('a report naming the scanner wins over the input, so observer matches the findings', () => {
  const [summary] = buildSummaries(
    { findings: [], scans: [{ tool: 'Opengrep OSS', toolVersion: '1.2.0' }], scanner: 'Opengrep', outcome: 'success' },
    misconfigurations
  ) as Doc[]
  assert.equal(summary.observer.vendor, 'Opengrep OSS')
  assert.equal(summary.data_stream.dataset, 'opengrep')
})

test('no scanner named anywhere, no summary', () => {
  assert.deepEqual(buildSummaries({ findings: [], scans: [], scanner: '', outcome: 'success' }, misconfigurations), [])
})
