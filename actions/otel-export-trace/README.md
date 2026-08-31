# otel-export-trace

Reconstruct and export the whole workflow → job → step trace for a complete
GitHub Actions run, over OTLP/gRPC.

Run this **once**, in a single final aggregation job (`needs: [...]`,
`if: always()`) — not per reusable workflow file. It reconstructs the *entire*
run's job/step tree from the GitHub Actions Jobs API using the run id, so a
second copy of this action running anywhere else in the same run (e.g. bolted
onto a reusable workflow that's only one part of a bigger orchestrated run)
would redundantly re-export the whole run's tree, prematurely (before sibling
jobs finish) and duplicated (deterministic span ids mean a traces data stream
would receive the same span twice).

It shares deterministic trace/span ids with
[`otel-instrument`](../otel-instrument) (same `githubreceiver`-compatible
scheme, from the shared `otel-core` module) so the live build spans emitted
during the job (Gradle tasks, JUnit tests, injected agents) nest correctly
under the job/step spans this action rebuilds after the fact.

This split used to be one action (`otel-collect`, `mode: instrument` vs.
`mode: export-all`) — two operationally unrelated things behind one `mode`
input made it easy to reach for the wrong one at a call site, including
mistakenly adding an aggregation job to every reusable workflow instead of
once at the true top level. `otel-instrument` and `otel-export-trace` are
named so that "runs in every job" vs. "runs once, at the end" is obvious
without reading the inputs.

## Why the split from `post`

Job and step span ids are deterministic (matching the OpenTelemetry Collector
`githubreceiver` scheme), so a job exporting its own tree on its `post` hook
and this action re-exporting the same tree would emit the *same* span id
twice — a traces data stream appends rather than upserts. The copy written
from inside a still-running job is also the wrong one: at that point the Jobs
API still reports that job as `in_progress` with no conclusion, so it would
land with a faked "success" and a wall-clock end time. `otel-export-trace`,
run once after every job has actually finished, is the single source of
truth for the GitHub Actions span layer.

With `logs-enabled: 'true'` it also downloads each job's GitHub Actions logs
and exports them as OTLP log records correlated to the job/step spans — only
available here, since logs aren't downloadable from the API until a job has
finished.

## Usage

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kestra-io/actions/actions/otel-instrument@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          otlp-endpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlp-headers: ${{ secrets.OTLP_HEADERS }}
      - run: ./gradlew check

  otel-export-trace:
    needs: [test]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: kestra-io/actions/actions/otel-export-trace@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          otlp-endpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlp-headers: ${{ secrets.OTLP_HEADERS }}
          logs-enabled: 'true'
```

If several reusable workflows are composed together into one bigger run by an
orchestrating workflow (they share that orchestrator's run id), put this job
in the **orchestrator**, `needs:` on every job across every composed
workflow — not inside any one of the composed reusable workflows themselves.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github-token` | — (required) | Token used to query the run's jobs/steps |
| `otlp-endpoint` | — (required) | OTLP **gRPC** endpoint (e.g. `https://<id>.ingest.<region>.elastic-cloud.com`; `https://` → TLS on :443) |
| `otlp-headers` | `''` | Comma-separated `k=v` headers, e.g. `Authorization=ApiKey <key>` (marked secret) |
| `logs-enabled` | `false` | Download each job's GitHub Actions logs and export them as OTLP log records correlated to the job/step spans (same trace id) |
| `service-name` | `''` | `service.name` resource attribute for the GitHub Actions layer (all signals also carry `service.namespace=github-actions`) |

## Outputs

| Output | Description |
|--------|-------------|
| `trace-id` | Deterministic trace id for the run |

## Development

```bash
npm install
npm test          # unit tests: this action's own (github-trace/github-logs) plus the shared otel-core ones
npm run build     # bundles src/ (and the shared otel-core modules it imports) into the committed dist/index.js
```

`dist/index.js` is committed and is what GitHub executes — always rebuild
after changing `src/` or the shared modules under `../../shared/otel-core`.
