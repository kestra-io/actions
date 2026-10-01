import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubMetadata } from '../../../shared/elastic-core/src/github.js'
import { toDocument } from './documents.js'
import { flattenTrufflehog, parseTrufflehog } from './trufflehog.js'

const SECRET = 'AKIAIOSFODNN7EXAMPLE-super-secret'
const line = (extra: object) =>
  JSON.stringify({
    DetectorName: 'AWS',
    DetectorDescription: 'AWS access key',
    Raw: SECRET,
    RawV2: SECRET,
    Redacted: 'AKIA…',
    ExtraData: { account: SECRET },
    SourceMetadata: { Data: { Filesystem: { file: 'ui/.env', line: 3 } } },
    ...extra
  })

const content = [
  line({ Verified: true }),
  line({ Verified: false, VerificationError: 'timeout' }),
  line({ Verified: false }),
  '{"level":"info","msg":"finished scanning"}',
  'not json'
].join('\n')

test('only detector lines are parsed', () => {
  assert.equal(parseTrufflehog(content).length, 3)
})

test('severity follows verification', () => {
  const findings = flattenTrufflehog(parseTrufflehog(content))
  assert.deepEqual(findings.map(f => f.severity), ['Critical', 'High', 'Medium'])
  assert.equal(findings[0].file, 'ui/.env')
  assert.equal(findings[0].startLine, 3)
})

test('the secret value never reaches the document', () => {
  const [finding] = flattenTrufflehog(parseTrufflehog(content))
  const document = toDocument(finding, {
    dataset: '',
    namespace: 'gha',
    type: 'misconfigurations',
    github: githubMetadata({ GITHUB_REPOSITORY: 'kestra-io/kestra' }),
    scanTime: '2026-09-24T10:00:00.000Z',
    tags: [],
    metadata: {}
  })
  assert.ok(!JSON.stringify(document).includes('super-secret'))
  assert.ok(!JSON.stringify(document).includes('AKIA…'))
})
