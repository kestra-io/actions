# otel-collect

Capture OpenTelemetry **metrics, traces and logs** for a complete GitHub Actions
workflow run, with real drill-down from the CI step into the build it ran
(Gradle tasks, JUnit tests, Node tests).

## Goal

CI traces are usually reconstructed *after the fact* from the GitHub API (e.g.
`corentinmusard/otel-cicd-action`). That gives you a workflow → job → step tree,
but it has **no visibility inside the build**: no host metrics, and the
Gradle/JUnit/Node spans (if you auto-instrument them) live in a *separate,
disconnected* trace — you cannot click from a slow CI step into the Gradle task
or JUnit test that made it slow.

`otel-collect` closes that gap. It produces **one trace per workflow run**,
drillable end to end:

```
workflow run
└─ job
   └─ step  "Gradle - check and javadoc"   ← GitHub step span
      └─ gradle :core:test                 ← live span from the Java agent
         └─ JUnit MyServiceTest#shouldWork ← live span from the Java agent
```

It does this by computing **deterministic span ids** (the same scheme the OTel
Collector `githubreceiver` uses) so the spans emitted *live* by the auto-instrumentation
agents and the spans rebuilt *post-hoc* from the GitHub API share ids and nest
correctly. Alongside the trace it ships **host metrics** (cpu / memory / network
/ io) for the runner, so you can correlate a slow build with resource pressure.

Use it to answer: *which step, task or test is slow or flaky, and was the runner
starved of CPU/memory/io while it ran?*

## What it does

When used in a job (`mode: instrument`, the default), on **`main`** it:

1. Computes a deterministic trace id (and root/job/step span ids) for the run,
   matching the OpenTelemetry Collector `githubreceiver` scheme.
2. Exports `TRACEPARENT` + `OTEL_EXPORTER_OTLP_*` so any child process the agents
   instrument attaches **under the GitHub step span** (drill-down).
3. Optionally downloads & caches the **Java agent** and **Node auto-instrumentation**
   and auto-injects them via `JAVA_TOOL_OPTIONS` / `NODE_OPTIONS`.
4. Optionally starts a background **`otelcol-contrib`** collector capturing host
   metrics (cpu / memory / network / disk io / load / paging).

On **`post`** (end of the job) it stops the collector (flushing metrics) and
exports the step spans for that job.

Run it once more in a final aggregation job with `mode: export-all` (and
`needs: [...] / if: always()`) to emit the whole workflow → job → step tree.

## Usage

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kestra-io/actions/composite/setup-build@main
        with: { java-enabled: 'true', node-enabled: 'true' }

      - uses: kestra-io/actions/actions/otel-collect@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          otlp-endpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlp-headers: ${{ secrets.OTLP_HEADERS }}
          java-enabled: 'true'
          node-enabled: 'true'
          parent-step-name: 'Gradle - check and javadoc'  # build spans nest here

      - name: Gradle - check and javadoc   # JAVA_TOOL_OPTIONS already carries the agent
        run: ./gradlew check javadoc --parallel

  otel-export:
    needs: [test]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: kestra-io/actions/actions/otel-collect@main
        with:
          mode: export-all
          github-token: ${{ secrets.GITHUB_TOKEN }}
          otlp-endpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlp-headers: ${{ secrets.OTLP_HEADERS }}
```

> The `otel-collect` step must run **before** the build step so the trace context
> and agent env vars are exported in time. `parent-step-name` must be a unique
> step name within the job.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github-token` | — (required) | Token used to query the run's jobs/steps |
| `otlp-endpoint` | — (required) | OTLP/HTTP base endpoint |
| `otlp-headers` | `''` | Comma-separated `k=v` headers (marked secret) |
| `mode` | `instrument` | `instrument` (per-job) or `export-all` (whole workflow) |
| `java-enabled` | `false` | Download the Java agent (path via `java-agent-path` output) |
| `node-enabled` | `false` | Install the Node auto-instrumentation (path via `node-agent-path` output) |
| `inject-agent` | `false` | Also inject the agents via `JAVA_TOOL_OPTIONS` / `NODE_OPTIONS`. **Do not** enable for apps that manage their own OpenTelemetry (e.g. Kestra) — see caveat below |
| `host-metrics-enabled` | `true` | Run the background host-metrics collector |
| `parent-step-name` | `''` | Build step name; build spans nest under it (else the job span) |
| `collector-version` | `0.114.0` | `otelcol-contrib` version |
| `java-agent-version` | `latest` | `opentelemetry-javaagent` version |
| `service-name` | `''` | `service.name` resource attribute |

## Outputs

| Output | Description |
|--------|-------------|
| `java-agent-path` | Path to the downloaded `opentelemetry-javaagent.jar` |
| `node-agent-path` | Path to the Node `register` module |
| `traceparent` | W3C traceparent exported for child instrumentation |
| `trace-id` | Deterministic trace id for the run |

## Development

```bash
npm install
npm test          # unit tests (deterministic ids + span hierarchy)
npm run build     # bundles src/ into the committed dist/index.js
```

`dist/index.js` is committed and is what GitHub executes — always rebuild after
changing `src/`.

> **Do not inject the agent into apps that own their OpenTelemetry.** With
> `inject-agent: true` the Java agent is added to `JAVA_TOOL_OPTIONS` for *every*
> JVM in the job, including Gradle's forked test workers. If the app under test
> manages its own OpenTelemetry (Kestra does), the agent takes over the global
> `OpenTelemetry` instance, so `GlobalOpenTelemetry.resetForTest()` becomes a
> no-op and test state leaks across tests — breaking otherwise-green builds. Keep
> `inject-agent` at its default `false` for Kestra/plugin builds; you still get
> the workflow step spans and host metrics. Only enable injection for services
> that do **not** configure OpenTelemetry themselves.
>
> **Note on the Java agent root span.** Even where injection is safe, the agent
> does not adopt the env `TRACEPARENT` as the JVM root parent by default — if you
> need the build spans to nest under the step span, add a Gradle init script that
> starts the build root span as a child of `TRACEPARENT`.
