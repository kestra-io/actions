import assert from 'node:assert/strict'
import { test } from 'node:test'
import { flattenTrivy, isTrivyReport, primaryScore, type TrivyReport } from './trivy.js'

// Trimmed from a real `trivy fs --format json` run against a pom with a vulnerable netty.
const report: TrivyReport = {
  SchemaVersion: 2,
  ArtifactName: '.',
  Trivy: { Version: '0.70.0' },
  Results: [
    {
      Target: 'pom.xml',
      Class: 'lang-pkgs',
      Type: 'pom',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2026-42583',
          PkgName: 'io.netty:netty-codec',
          PkgIdentifier: { PURL: 'pkg:maven/io.netty/netty-codec@4.1.118.Final' },
          InstalledVersion: '4.1.118.Final',
          FixedVersion: '4.1.133.Final',
          Status: 'fixed',
          Title: 'netty: denial of service',
          Description: 'A decompression bomb.',
          Severity: 'HIGH',
          SeveritySource: 'ghsa',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2026-42583',
          PublishedDate: '2026-05-13T19:17:23.903Z',
          LastModifiedDate: '2026-06-17T10:48:05.55Z',
          CweIDs: ['CWE-400', 'CWE-770'],
          References: ['https://access.redhat.com/security/cve/CVE-2026-42583', 'https://github.com/netty/netty'],
          DataSource: {
            ID: 'ghsa',
            Name: 'GitHub Security Advisory Maven',
            URL: 'https://github.com/advisories?query=type%3Areviewed+ecosystem%3Amaven'
          },
          CVSS: {
            ghsa: { V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', V3Score: 7.5 },
            redhat: { V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', V3Score: 7.5 }
          }
        }
      ]
    }
  ]
}

test('isTrivyReport tells a native report from a SARIF log', () => {
  assert.equal(isTrivyReport(report), true)
  assert.equal(isTrivyReport({ version: '2.1.0', runs: [] }), false)
  assert.equal(isTrivyReport({ Results: [] }), false, 'SchemaVersion is what makes it Trivy')
  assert.equal(isTrivyReport(null), false)
  assert.equal(isTrivyReport('a string'), false)
})

test('reads the fields SARIF drops', () => {
  const [finding] = flattenTrivy(report)
  assert.deepEqual(finding.dataSource, {
    ID: 'ghsa',
    Name: 'GitHub Security Advisory Maven',
    URL: 'https://github.com/advisories?query=type%3Areviewed+ecosystem%3Amaven'
  })
  assert.equal(finding.publishedDate, '2026-05-13T19:17:23.903Z')
  assert.equal(finding.lastModifiedDate, '2026-06-17T10:48:05.55Z')
  assert.equal(Object.keys(finding.cvss ?? {}).join(','), 'ghsa,redhat')
  assert.deepEqual(finding.cwes, ['CWE-400', 'CWE-770'])
  assert.equal(finding.purl, 'pkg:maven/io.netty/netty-codec@4.1.118.Final')
  assert.equal(finding.fixStatus, 'fixed')
  assert.equal(finding.references?.length, 2)
})

test('reads the fields SARIF also carries, identically', () => {
  const [finding] = flattenTrivy(report)
  assert.equal(finding.tool, 'Trivy')
  assert.equal(finding.toolVersion, '0.70.0')
  assert.equal(finding.ruleId, 'CVE-2026-42583')
  assert.equal(finding.severity, 'High')
  assert.equal(finding.score, 7.5)
  assert.equal(finding.scoreVersion, '3.1')
  assert.equal(finding.packageName, 'io.netty:netty-codec')
  assert.equal(finding.packageVersion, '4.1.118.Final')
  assert.equal(finding.packageFixedVersion, '4.1.133.Final')
  assert.equal(finding.file, 'pom.xml')
  assert.equal(finding.level, 'error', 'High maps to the SARIF level a scanner would have written')
})

test('primaryScore prefers the vendor the severity was derived from', () => {
  const cvss = {
    nvd: { V3Score: 9.8, V3Vector: 'CVSS:3.1/AV:N' },
    ghsa: { V3Score: 7.5, V3Vector: 'CVSS:4.0/AV:N' }
  }
  assert.deepEqual(primaryScore(cvss, 'ghsa'), { score: 7.5, version: '4.0' })
  assert.deepEqual(primaryScore(cvss, undefined), { score: 9.8, version: '3.1' }, 'nvd is the fallback')
  assert.deepEqual(primaryScore(cvss, 'absent-vendor'), { score: 9.8, version: '3.1' })
  assert.deepEqual(primaryScore({ redhat: { V3Score: 5.5 } }, undefined), { score: 5.5, version: '3.1' })
  assert.deepEqual(primaryScore({ old: { V2Score: 4.3, V2Vector: 'AV:N/AC:M' } }, undefined), { score: 4.3, version: '2.0' })
  assert.deepEqual(primaryScore(undefined, 'ghsa'), {})
  assert.deepEqual(primaryScore({ empty: {} }, undefined), {}, 'a vendor with no score is skipped')
})

test('a vulnerability with no CVSS still lands, scored by its severity word', () => {
  const bare: TrivyReport = {
    SchemaVersion: 2,
    Results: [{ Target: 'go.mod', Vulnerabilities: [{ VulnerabilityID: 'GHSA-x', Severity: 'LOW' }] }]
  }
  const [finding] = flattenTrivy(bare)
  assert.equal(finding.severity, 'Low')
  assert.equal(finding.score, undefined)
  assert.equal(finding.scoreVersion, undefined)
  assert.equal(finding.level, 'warning')
})

test('a result with no vulnerabilities yields nothing', () => {
  assert.deepEqual(flattenTrivy({ SchemaVersion: 2, Results: [{ Target: 'pom.xml' }] }), [])
  assert.deepEqual(flattenTrivy({ SchemaVersion: 2 }), [])
})
