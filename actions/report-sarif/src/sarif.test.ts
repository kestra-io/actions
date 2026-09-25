import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cweIds, severityFromScore, scoreVersion } from './finding.js'
import { flatten, parseTrivyPackage, type SarifLog } from './sarif.js'

const trivy: SarifLog = {
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'Trivy',
          version: '0.58.1',
          rules: [
            {
              id: 'CVE-2024-1234',
              name: 'OsPackageVulnerability',
              shortDescription: { text: 'CVE-2024-1234 Package: openssl' },
              fullDescription: { text: 'A buffer overflow in openssl.' },
              helpUri: 'https://avd.aquasec.com/nvd/cve-2024-1234',
              defaultConfiguration: { level: 'error' },
              properties: { tags: ['vulnerability', 'security', 'CRITICAL'], 'security-severity': '9.8' }
            }
          ]
        }
      },
      results: [
        {
          ruleId: 'CVE-2024-1234',
          ruleIndex: 0,
          level: 'error',
          message: {
            text: 'Package: openssl\nInstalled Version: 1.1.1\nVulnerability CVE-2024-1234\nSeverity: CRITICAL\nFixed Version: 1.1.1n\nLink: [CVE-2024-1234](https://avd.aquasec.com/nvd/cve-2024-1234)'
          },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'build/libs/plugin.jar' }, region: { startLine: 1 } } }]
        }
      ]
    }
  ]
}

const opengrep: SarifLog = {
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'opengrep',
          semanticVersion: '1.30.0',
          rules: [
            {
              id: 'java.lang.security.audit.unsafe-reflection',
              shortDescription: { text: 'Unsafe reflection' },
              helpUri: 'https://example.invalid/rule',
              defaultConfiguration: { level: 'warning' },
              properties: { tags: ['CWE-470: Unsafe Reflection', 'OWASP-A03'] }
            }
          ]
        }
      },
      results: [
        {
          ruleId: 'java.lang.security.audit.unsafe-reflection',
          ruleIndex: 0,
          level: 'warning',
          message: { text: 'Found unsafe reflection.' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'core/src/main/java/Foo.java' },
                region: { startLine: 42, startColumn: 5, endLine: 44, snippet: { text: 'Class.forName(name)' } }
              }
            }
          ],
          partialFingerprints: { 'opengrep.similarity': 'abc123' }
        }
      ]
    }
  ]
}

test('reads a Trivy package vulnerability', () => {
  const [finding] = flatten(trivy)
  assert.equal(finding.tool, 'Trivy')
  assert.equal(finding.toolVersion, '0.58.1')
  assert.equal(finding.ruleId, 'CVE-2024-1234')
  assert.equal(finding.severity, 'Critical')
  assert.equal(finding.score, 9.8)
  assert.equal(finding.packageName, 'openssl')
  assert.equal(finding.packageVersion, '1.1.1')
  assert.equal(finding.packageFixedVersion, '1.1.1n')
  assert.equal(finding.file, 'build/libs/plugin.jar')
})

test('reads an OpenGrep code finding', () => {
  const [finding] = flatten(opengrep)
  assert.equal(finding.tool, 'opengrep')
  assert.equal(finding.toolVersion, '1.30.0')
  assert.equal(finding.severity, 'Medium')
  assert.equal(finding.score, undefined)
  assert.deepEqual(finding.cwes, ['CWE-470'])
  assert.equal(finding.startLine, 42)
  assert.equal(finding.endLine, 44)
  assert.equal(finding.snippet, 'Class.forName(name)')
  assert.equal(finding.fingerprint, 'abc123')
  assert.equal(finding.packageName, undefined)
})

test('a severity tag wins over the CVSS band it disagrees with', () => {
  const log: SarifLog = {
    runs: [
      {
        tool: { driver: { name: 'Trivy', rules: [{ id: 'CVE-1', properties: { tags: ['LOW'], 'security-severity': '9.9' } }] } },
        results: [{ ruleId: 'CVE-1', ruleIndex: 0, level: 'error' }]
      }
    ]
  }
  const [finding] = flatten(log)
  assert.equal(finding.severity, 'Low')
  assert.equal(finding.score, 9.9)
})

test('falls back to the SARIF level when nothing else states a severity', () => {
  const log: SarifLog = { runs: [{ tool: { driver: { name: 'x' } }, results: [{ ruleId: 'r', level: 'note' }] }] }
  assert.equal(flatten(log)[0].severity, 'Low')
})

test('resolves a rule by id when ruleIndex is absent', () => {
  const log: SarifLog = {
    runs: [
      {
        tool: { driver: { name: 'x', rules: [{ id: 'a' }, { id: 'b', shortDescription: { text: 'B rule' } }] } },
        results: [{ ruleId: 'b' }]
      }
    ]
  }
  assert.equal(flatten(log)[0].title, 'B rule')
})

test('an empty or runless log yields nothing', () => {
  assert.deepEqual(flatten({}), [])
  assert.deepEqual(flatten({ runs: [{ tool: { driver: { name: 'x' } } }] }), [])
})

test('severityFromScore uses the CVSS v3 bands', () => {
  assert.equal(severityFromScore(9), 'Critical')
  assert.equal(severityFromScore(8.9), 'High')
  assert.equal(severityFromScore(4), 'Medium')
  assert.equal(severityFromScore(3.9), 'Low')
  assert.equal(severityFromScore(0), 'Unknown')
})

test('cweIds dedupes and normalises', () => {
  assert.deepEqual(cweIds(['cwe-79: XSS', 'CWE-79', 'CWE-89']), ['CWE-79', 'CWE-89'])
  assert.deepEqual(cweIds(['no identifier here']), [])
})

test('parseTrivyPackage ignores a message that is not Trivy shaped', () => {
  assert.deepEqual(parseTrivyPackage('Found unsafe reflection.'), {
    packageName: undefined,
    packageVersion: undefined,
    packageFixedVersion: undefined
  })
})

test('reads the CVSS version off the vector, defaulting to 3.1', () => {
  assert.equal(scoreVersion('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N'), '3.1')
  assert.equal(scoreVersion('CVSS:4.0/AV:N/AC:L'), '4.0')
  assert.equal(scoreVersion('AV:N/AC:L/Au:N/C:P'), undefined, 'a v2 vector names no version')
  assert.equal(scoreVersion(undefined), undefined)

  const withVector: SarifLog = {
    runs: [
      {
        tool: {
          driver: {
            name: 'Trivy',
            rules: [{ id: 'CVE-1', properties: { 'security-severity': '8.1', cvssv3_vector: 'CVSS:4.0/AV:N/AC:L' } }]
          }
        },
        results: [{ ruleId: 'CVE-1', ruleIndex: 0 }]
      }
    ]
  }
  assert.equal(flatten(withVector)[0].scoreVersion, '4.0')

  const noVector: SarifLog = {
    runs: [
      {
        tool: { driver: { name: 'Trivy', rules: [{ id: 'CVE-2', properties: { 'security-severity': '8.1' } }] } },
        results: [{ ruleId: 'CVE-2', ruleIndex: 0 }]
      }
    ]
  }
  assert.equal(flatten(noVector)[0].scoreVersion, '3.1')
  assert.equal(flatten({ runs: [{ tool: { driver: {} }, results: [{ ruleId: 'r' }] }] })[0].scoreVersion, undefined)
})
