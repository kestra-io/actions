# report-sarif

Ship SARIF scan results to Elastic Cloud as security findings.

Any SARIF 2.1.0 producer works, and Trivy's own JSON report is read natively. The two in this repository are
[`scan-opengrep`](../scan-opengrep) (static analysis of the source tree) and
[`scan-trivy`](../../composite/scan-trivy) (CVEs in built artifacts), and the
document builder normalises both onto the same ECS `vulnerability.*` shape, so
a single Elastic view covers SAST and dependency findings together.

## Where the data goes

Elastic Cloud's **Managed OTLP Endpoint** exposes an Elasticsearch-compatible
`_bulk` input on the `/_es` path of the same ingest host the OTel actions in
this repository already point at, so shipping findings needs no separate
cluster URL and no direct Elasticsearch access —
[docs](https://www.elastic.co/docs/reference/opentelemetry/managed-inputs/elasticsearch-bulk).

That input is deliberately narrow, and the action is built around its limits:

| Limit | What the action does |
| :--- | :--- |
| `create` actions only; `index`/`update`/`delete` are `400` | Emits only `create` |
| Targets not prefixed `logs-` are accepted and then **silently dropped** | One stream per scanner, `logs-<tool>-<namespace>`, and the prefix is not configurable |
| Log data only | Findings are shipped as log documents, not metrics |
| A batch is accepted or rejected atomically | Batches of `batch-size` (500 by default), each retried as a unit |
| No `_id` deduplication, so a retry can duplicate | Every document carries a stable `event.id`, so a transform can collapse duplicates |
| `2xx` means durably accepted, **not** indexed | Indexing errors surface asynchronously in Data Set Quality, never in the response |

## Usage

```yaml
- name: OpenGrep - Scan
  id: scan
  uses: kestra-io/actions/composite/scan-opengrep@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: OpenGrep - Report findings to Elastic
  uses: kestra-io/actions/actions/report-sarif@main
  if: ${{ !cancelled() && env.OTLP_ENDPOINT != '' }}
  continue-on-error: true
  with:
    sarif-files: ${{ steps.scan.outputs.sarif-file }}
    elastic-endpoint: ${{ secrets.OTLP_ENDPOINT }}
    elastic-headers: "${{ secrets.OTLP_HEADERS }}"
    type: misconfigurations
    metadata: |
      service.name=kestra-ee
      component=backend
```

## Two kinds of finding

`type` decides the document shape, because Elastic keeps them in different
views and a scanner only fits one:

| `type` | For | Shape |
| :--- | :--- | :--- |
| `vulnerabilities` (default) | Trivy — a CVE in a dependency | `vulnerability.*`, `package.*`, `event.category: vulnerability` |
| `misconfigurations` | OpenGrep — a rule a file breaks | `rule.*`, `result.evaluation`, `event.category: configuration`, `event.outcome: failure` |

Static analysis has no CVE, no package and no CVSS, so shipping it as a
vulnerability leaves most of that shape empty and files it in the wrong view.
A misconfiguration still carries `vulnerability.cwe` and `vulnerability.severity`,
so a weakness class is filterable across both.

The Findings list reads columns that have no natural equivalent in a scanner
report, so they are derived:

| Column | Field | Derived from |
| :--- | :--- | :--- |
| Resource Type | `resource.sub_type` | the file's language — `yaml`, `dockerfile`, `java`, `maven` |
| Rule Number | `rule.benchmark.rule_number` | the rule id, the only number a scanner rule has |
| Framework Section | `rule.section` | the rule's OWASP tag, else its CWE description, else the id's leading namespace |
| Framework | `rule.benchmark.name` | the tool. Kibana draws an icon only for benchmarks it knows (`cis_gcp`, `cis_aws`, …), so OpenGrep gets a name without one |

`rule.rationale` is the description after its opening sentence — a rule states
itself first and explains itself second — and `rule.remediation` is the SARIF
`help` text.

## One data stream per scanner

`logs-<tool>-<namespace>`, the tool being the first word of the SARIF driver
name lowercased — so `logs-opengrep-gha` and `logs-trivy-gha`. Findings from
several tools in one call are grouped and shipped to their own streams, so one
scanner's volume never buries another's. Set `dataset` to pin everything to a
single stream instead.

No new secret: the `_bulk` input shares its host and its authentication with the
Managed OTLP Endpoint, so the `OTLP_ENDPOINT` / `OTLP_HEADERS` pair these
workflows already pass to `otel-instrument` works here unchanged, behind the
same `env.OTLP_ENDPOINT != ''` opt-out guard. A caller holding only the key
itself can pass `elastic-api-key` instead; it takes precedence.

This is already wired after the OpenGrep scan in the five reusable workflows
that run one — `kestra-oss-backend-tests`, `kestra-oss-frontend-tests`,
`kestra-ee-backend-tests`, `kestra-ee-frontend-tests` and `plugins` — and after
the Trivy scan in `plugins`, each tagging its findings with a `service.name` and
a `component` of `backend`, `frontend` or `plugin`. Static analysis and
dependency CVEs land in the same data stream, which is the point: one view over
both, split by `vulnerability.scanner.vendor` when you want them apart.

`composite/scan-trivy` scans once and renders twice — the pull request comment
keeps reading the JSON, and `trivy convert` re-renders that same report as the
SARIF this action ships, rather than paying for a second scan.

An empty `sarif-files` is a warning rather than a failure, because the usual
wiring passes a scan step's output and that output is empty whenever the scan
itself skipped.

### Trivy: pass the JSON, not the SARIF

The format is detected by shape, so `sarif-files` takes Trivy's native report
too — and for Trivy that is the one to pass. SARIF drops three things the
Elastic vulnerability flyout has panels for, and they render as `-` without it:

| Panel | Field | Only in |
| :--- | :--- | :--- |
| Data source | `vulnerability.data_source.ID` / `.Name` / `.URL` | Trivy JSON |
| Published | `vulnerability.published_date` | Trivy JSON |
| Vulnerability Score | `vulnerability.cvss` — every scoring vendor's score and vector | Trivy JSON |

The JSON also carries proper `CweIDs` rather than CWEs smuggled through
free-text rule tags, plus the package PURL, the fix status and the full
reference list. `composite/scan-trivy` exposes it as `json-file`.

OpenGrep has no advisory behind it, so its findings leave those fields empty
whichever format they arrive in.

`sarif-files` is a newline separated list of globs, so one step can ship every
report a job produced:

```yaml
    sarif-files: |
      ${{ runner.temp }}/opengrep.sarif
      **/trivy-*.sarif
```

The key needs the `event:write` privilege on the `apm` application — the same
privilege the Managed OTLP Endpoint uses, which is why the same secret serves
both.

## Failure behaviour

`fail-on-error` defaults to `false`, matching `otel-export-trace`: an
unreachable ingest endpoint is an infrastructure problem and must not redden a
pull request whose scan itself succeeded. Missing SARIF files are a warning for
the same reason — `scan-opengrep` legitimately produces no report when the rule
registry is unreachable, and a skipped scan must not turn into a failed ship.

An invalid data stream target is the exception and fails the step outright,
because the endpoint's response to one is a `2xx` followed by silence.

## Metadata

`metadata` is a newline separated `key=value` list added to every document. A
dotted key is written at that path, an undotted one lands under `labels`:

```yaml
metadata: |
  service.name=kestra-ee     # -> { "service": { "name": "kestra-ee" } }
  team=platform              # -> { "labels": { "team": "platform" } }
```

## Document shape

One document per SARIF result, in ECS:

| Field | Source |
| :--- | :--- |
| `vulnerability.id` / `rule.id` | the SARIF `ruleId` — a CVE or GHSA for Trivy, a rule path for OpenGrep |
| `vulnerability.cve` / `.enumeration` | only when the id is an advisory: `CVE-…` or `GHSA-…` |
| `vulnerability.severity` | a severity tag if the producer set one, else the CVSS band of `security-severity`, else the SARIF `level` |
| `vulnerability.score.base` / `.version` / `.classification` | `properties["security-severity"]`, when the producer reported one |
| `vulnerability.cwe` | CWE ids parsed out of the rule tags |
| `vulnerability.scanner.vendor` / `.version` | `tool.driver` |
| `event.severity` | the severity as a sortable 0-100 band — `Critical` 99, `High` 73, `Medium` 47, `Low` 21 |
| `package.*` | structured fields from Trivy's JSON; parsed back out of the result message when only SARIF is available, which is where it puts the package instead |
| `vulnerability.data_source.*`, `.published_date`, `.cvss` | Trivy's JSON only — see below |
| `related.references` | every reference the advisory lists, beyond the primary one |
| `file.*`, `log.origin.file.line`, `url.full` | the first physical location; `url.full` is omitted for package findings, whose location is a build artifact rather than a tracked file |
| `resource.*` | the scanned file: `name` (path), `sub_type` (language), `directory`, `file`, `line`, `url`, plus `repository`. Falls back to the repository when a finding has no location |
| `rule.section`, `rule.benchmark.rule_number` | the Findings list's "Framework Section" and "Rule Number" columns |
| `user.name` / `.id` | the triggering actor, falling back to the actor |
| `organization.name` / `.id` | the repository owner |
| `event.id` | `sha256(repository, tool, rule, file, line, package)` |
| `github.*` | everything the runner knows about the run that observed the finding |
| `sarif.*` | the raw `level`, `ruleId`, `ruleName`, `fingerprint`, `snippet` and region, kept for anything the ECS fields flatten away |

`event.id` is stable across runs, so repeated scans are a time series of one
finding rather than a new finding each time; `event.sequence` carries the run
id that observed it, which is how a current finding is told apart from a stale
one.

### Readable names

OpenGrep and Semgrep both set the SARIF `shortDescription` to
`"<Tool> Finding: <rule id>"` — and for a rule loaded off disk the id in there
is a runner temp path, so the finding arrived as
`Opengrep Finding: home.runner.work._temp.kestra-mutable-action-tag`. That
boilerplate is dropped in favour of, in order: whatever the producer actually
wrote, the opening sentence of the description if it is short enough to read as
a title, or the rule id made readable
(`dockerfile.security.missing-user-entrypoint.missing-user-entrypoint` →
`Missing user entrypoint`).

The message then reads like the posture findings already in the cluster:

```
Rule "By not specifying a USER, a program in the container may run as 'root'.": failed at Dockerfile:12
```

`vulnerability.severity` is title case (`High`, not `HIGH`) and `event.kind` is
`event` for vulnerabilities and `state` for misconfigurations, matching the
integrations already feeding this cluster — a finding shipped as `HIGH` would sit in its own bucket beside theirs
in the same Findings view instead of aggregating with them.

### Fields that will be missing

Most of them, most of the time. This is normal, and it is true of Elastic's own
integrations: of the 42,551 documents in `security_solution-google_scc.vulnerability_latest`,
`vulnerability.score.base` is set on 2,546 of them and `vulnerability.cve` on
41,286. Empty values are dropped rather than written as `null`, so a missing
field is absent from the document entirely.

| Field | Absent when |
| :--- | :--- |
| `vulnerability.cve`, `.enumeration` | the advisory is GHSA-only, or the finding is static analysis with no advisory at all |
| `vulnerability.score.base`, `.version`, `.classification` | the producer reported no CVSS score — the common case, including every OpenGrep finding |
| `vulnerability.cwe` | the rule carries no CWE tag |
| `package.*` | a static analysis finding; `package.fixed_version` alone is absent when no fix has shipped yet |
| `file.*`, `log.origin.file.line`, `sarif.startLine` | the result has no physical location |
| `url.full` | a package finding, whose location is a build artifact rather than a tracked file |
| `github.pullRequest`, `.baseRef`, `.headRef` | the run was not triggered by a pull request |
| `github.*` generally | running outside GitHub Actions, where the environment variables are unset |

Nothing downstream should key on an optional field. The three that are always
present are `vulnerability.id`, `vulnerability.severity` and `event.id` — a
dashboard or transform should group on those, and treat `vulnerability.cve` as
a display nicety rather than the identity of a finding.

### The `github` namespace

Elastic's own integrations put ECS fields on top and everything the source
contributes below a single namespace named after it — a Google SCC document
carries `google_scc.asset.*`, not a handful of fields scattered across the
root. The CI context follows the same rule, so filtering findings by origin is
one prefix and nothing collides with ECS:

| Field | Useful for |
| :--- | :--- |
| `github.repository`, `.repositoryId`, `.repositoryOwner`, `.repositoryOwnerId` | scoping to a repository or a whole org, by name or by id when a repository is renamed |
| `github.sha`, `.ref`, `.refName`, `.refType` | which commit and branch or tag the finding was observed on |
| `github.baseRef`, `.headRef` | the difference between "this is on main" and "this would land on main" |
| `github.pullRequest.number`, `.url` | jumping from a finding straight to the pull request that carries it |
| `github.eventName` | separating scheduled full scans from pull request diff scans |
| `github.workflow`, `.workflowRef`, `.job` | which workflow file and job produced it |
| `github.runId`, `.runNumber`, `.runAttempt`, `.runUrl` | opening the run, at the right attempt |
| `github.actor`, `.actorId`, `.triggeringActor` | who to ask; also mirrored into ECS `user.*` |
| `github.serverUrl`, `.apiUrl` | telling GitHub Enterprise instances apart from github.com |
| `github.runner.os`, `.arch`, `.name`, `.environment` | splitting findings by runner flavour, e.g. hosted vs self-hosted |

Everything is read from the default environment variables, so no caller has to
wire a `github` context expression into an input. `runNumber` and `runAttempt`
are numbers so they sort and range-filter; every id stays a string, since an id
is an identifier rather than a quantity.

The two namespaces this action owns, `github.*` and `sarif.*`, are camelCase.
ECS fields keep their canonical names — `package.fixed_version`,
`vulnerability.report_id`, `log.origin.file.line`, `data_stream.*` — because
those are what Elastic's security views and the latest-state transforms read,
and renaming them would take the findings straight out of those views.

## Surfacing in Elastic Security's Findings UI

The `/_es` input can only write `logs-` data streams, and Elastic Security's
**Vulnerability Findings** page reads latest-state indices matching
`security_solution-*.vulnerability_latest`. Bridging the two is a one-off
Elasticsearch transform, created out of band by someone with cluster access —
it cannot be installed through this endpoint, and the action does not try:

```json
PUT _transform/security-findings-latest
{
  "source": { "index": "logs-security_scan.findings-github-actions" },
  "dest": { "index": "security_solution-github_scan.vulnerability_latest-v1" },
  "sync": { "time": { "field": "@timestamp", "delay": "60s" } },
  "latest": { "unique_key": ["event.id"], "sort": "@timestamp" },
  "frequency": "5m"
}
```

Then alias the destination so the UI's index pattern matches it:

```json
POST _aliases
{
  "actions": [{
    "add": {
      "index": "security_solution-github_scan.vulnerability_latest-v1",
      "alias": "security_solution-github_scan.vulnerability_latest"
    }
  }]
}
```

Until that transform exists the findings are still queryable in Discover and
usable in dashboards and alerts from the data stream directly — they just do
not appear on the Findings page.

## Development

```bash
npm ci
npm test
npm run build   # typechecks, then bundles src/ into the committed dist/index.js
```

`tsconfig.json` sets `types: ["node"]` here, unlike the other actions: those
pull `@types/node` in transitively through `@actions/cache` and `@octokit`,
and this action's dependencies are too thin to drag it along.
