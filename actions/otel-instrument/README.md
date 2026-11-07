# otel-instrument

Per-job OpenTelemetry setup for a GitHub Actions job: trace context, host/cgroup
metrics, and optional Java/Node agent + Gradle/JUnit/Vitest tracing.

Run this in **every job** you want telemetry for. It sets up the root span
context and starts a background host-metrics collector on the `main` hook,
then stops/flushes that collector on the `post` hook. It exports **no spans**
of its own — see [`otel-export-trace`](../otel-export-trace) for that, which
you run **once**, in a single final aggregation job, to reconstruct the whole
workflow → job → step trace from the GitHub Actions API.

This split used to be one action (`otel-collect`, `mode: instrument` vs.
`mode: export-all`) — two operationally unrelated things behind one `mode`
input made it easy to reach for the wrong one at a call site. `otel-instrument`
and `otel-export-trace` are named so that "runs in every job" vs. "runs once,
at the end" is obvious without reading the inputs.

## What it does

On **`main`** it:

1. Computes a deterministic trace id (and root/job/step span ids) for the run,
   matching the OpenTelemetry Collector `githubreceiver` scheme — the same
   scheme `otel-export-trace` uses, so live spans and the post-hoc rebuilt
   tree share ids and nest correctly.
2. Exports `TRACEPARENT` + `OTEL_EXPORTER_OTLP_*` so any child process the
   agents instrument attaches **under the GitHub step span** (drill-down).
3. Optionally downloads & caches the **Java agent** and **Node
   auto-instrumentation** and auto-injects them via `JAVA_TOOL_OPTIONS` /
   `NODE_OPTIONS`.
4. Optionally starts a background **`otelcol-contrib`** collector capturing
   host metrics (cpu / memory / network / disk io / load / paging), plus a
   cgroup v2 poller for this job's own container CPU/memory limits. The
   collector binary (tens of MB, never cache-hit on ephemeral runners) is
   downloaded and started by a detached launcher process, so this step
   returns without waiting for it — see "Run this first" below.
5. Optionally installs a Gradle init script emitting a span per Gradle task
   and per JUnit test, nested under the step span.
6. Optionally exposes a Vitest reporter emitting a span per run, test file and
   test (see "Vitest tracing" below).

On **`post`** it exports the Vitest spans recorded during the job, then stops
the collector/poller, flushing their metrics. It exports no GitHub Actions
spans — see `otel-export-trace`'s README for why.

## Usage

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: kestra-io/actions/actions/otel-instrument@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          otlp-endpoint: ${{ secrets.OTLP_ENDPOINT }}
          otlp-headers: ${{ secrets.OTLP_HEADERS }}
          java-enabled: 'true'
          node-enabled: 'true'
          parent-step-name: 'Gradle - check and javadoc'  # build spans nest here

      - uses: actions/checkout@v4
      - uses: kestra-io/actions/composite/setup-build@main
        with: { java-enabled: 'true', node-enabled: 'true' }

      - name: Gradle - check and javadoc   # JAVA_TOOL_OPTIONS already carries the agent
        run: ./gradlew check javadoc --parallel

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
```

> **Run this first, before `actions/checkout`.** None of its inputs depend on
> the checked-out repo, and putting it first means checkout itself (and
> anything before the build step) is captured under the trace and by the
> host-metrics collector instead of missed. It must still run **before** the
> build step so the trace context and agent env vars are exported in time.
> `parent-step-name` must be a unique step name within the job.
>
> The collector download/startup runs in a detached background process — by
> far the largest one-time download (tens of MB, never cache-hit on ephemeral
> runners) — so it never blocks this step or anything after it. The Java/Node
> agent downloads (only when `java-enabled`/`node-enabled`) still complete
> before the step returns, since their paths are exposed as outputs, but now
> run concurrently with each other instead of one after the other.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `github-token` | — (required) | Token used to resolve the current job id |
| `otlp-endpoint` | — (required) | OTLP **gRPC** endpoint (e.g. `https://<id>.ingest.<region>.elastic-cloud.com`; `https://` → TLS on :443) |
| `otlp-headers` | `''` | Comma-separated `k=v` headers, e.g. `Authorization=ApiKey <key>` (marked secret) |
| `java-enabled` | `false` | Download the Java agent (path via `java-agent-path` output) |
| `node-enabled` | `false` | Install the Node auto-instrumentation (path via `node-agent-path` output) |
| `inject-java-agent` | `false` | Also inject the Java agent via `JAVA_TOOL_OPTIONS`. **Do not** enable for apps that manage their own OpenTelemetry (e.g. Kestra) — see caveat below |
| `inject-node-agent` | `false` | Also inject the Node auto-instrumentation via `NODE_OPTIONS` / `NODE_PATH`. Same caveat as above |
| `host-metrics-enabled` | `true` | Run the background host-metrics collector |
| `cgroup-metrics-enabled` | `true` | Run a background poller emitting this job's own `container.cpu.*`/`container.memory.*` **cgroup v2** metrics, including CPU throttling. Unlike the host-metrics `cpu`/`memory` scrapers above, which read `/proc` and report the whole **node** on Kubernetes runners, these reflect the cgroup limit actually enforced on this job. CPU is a cumulative counter — cores used is `rate(container.cpu.time)`, utilization is that divided by `container.cpu.limit`. Logs and skips where there is no cgroup v2 (macOS/Windows). Only takes effect when `host-metrics-enabled` is also true |
| `gradle-tracing-enabled` | `false` | Install a Gradle init script emitting a span per task and per JUnit test, nested under the step span (gRPC). Daemon-side, so no conflict with the app's own OpenTelemetry — this is how you get **per-test drill-down**. Task spans use `service.name=<service-name> - Gradle`, test spans `<service-name> - JUnit`, both tagged `telemetry.source` |
| `vitest-tracing-enabled` | `false` | Expose a Vitest reporter in `OTEL_VITEST_REPORTER` emitting a span per run, test file and test, with `service.name=<service-name> - Vitest` and `telemetry.source=vitest`. See "Vitest tracing" below |
| `parent-step-name` | `''` | Build step name; build spans nest under it (else the job span) |
| `collector-version` | `0.114.0` | `otelcol-contrib` version |
| `java-agent-version` | `latest` | `opentelemetry-javaagent` version |
| `service-name` | `''` | `service.name` resource attribute for the GitHub Actions layer (all signals also carry `service.namespace=github-actions`). Gradle/JUnit spans (see `gradle-tracing-enabled`) derive their own ` - Gradle`/` - JUnit` suffixed service names from this |

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
npm test          # unit tests: this action's own (cgroup/gradle) plus the shared otel-core ones
npm run build     # bundles src/ (and the shared otel-core modules it imports) into the committed dist/index.js
```

`dist/index.js` is committed and is what GitHub executes — always rebuild
after changing `src/` or the shared modules under `../../shared/otel-core`.

> **Do not inject the agent into apps that own their OpenTelemetry.** With
> `inject-java-agent: true` the Java agent is added to `JAVA_TOOL_OPTIONS` for
> *every* JVM in the job, including Gradle's forked test workers (the Node
> agent behaves the same via `inject-node-agent`). If the app under test
> manages its own OpenTelemetry (Kestra does), the agent takes over the
> global `OpenTelemetry` instance, so `GlobalOpenTelemetry.resetForTest()`
> becomes a no-op and test state leaks across tests — breaking otherwise-green
> builds. Keep `inject-java-agent` / `inject-node-agent` at their default
> `false` for Kestra/plugin builds; you still get the workflow step spans and
> host metrics. Only enable injection for services that do **not** configure
> OpenTelemetry themselves.
>
> **Note on the Java agent root span.** Even where injection is safe, the
> agent does not adopt the env `TRACEPARENT` as the JVM root parent by
> default — if you need the build spans to nest under the step span, add a
> Gradle init script that starts the build root span as a child of
> `TRACEPARENT` (`gradle-tracing-enabled` does exactly this).

## Vitest tracing

Vitest has no env hook to load a reporter, so add it on the command line. Set
`OTEL_STEP_NAME` to the step's own name to nest the spans under that step:

```yaml
- name: Unit tests
  env:
    OTEL_STEP_NAME: Unit tests
  run: npm run test:unit -- ${OTEL_VITEST_REPORTER:+--reporter=$OTEL_VITEST_REPORTER}
```

A `--reporter` flag replaces the `reporters` set in `vitest.config`, so when the
config already lists some (e.g. `junit`), add it there instead:

```ts
reporters: ["default", "junit", ...(process.env.OTEL_VITEST_REPORTER ? [process.env.OTEL_VITEST_REPORTER] : [])],
```

The reporter only uses node builtins (Vitest loads it through Vite's module
runner): it writes span records under `$RUNNER_TEMP`, and the action's `post`
exports them over gRPC at the end of the job.

## Nesting a tool's spans under a specific step

`TRACEPARENT` points at the job span (or `parent-step-name`). Tools that read it
on their own, like `docker compose`, then show up under the job rather than the
step that ran them. `OTEL_TRACE_ID` and `OTEL_JOB_ID` are exported so a step can
derive its own span id (`sha256("<job id>-<step name>-s")[16:32]`):

```bash
export TRACEPARENT="00-$OTEL_TRACE_ID-$(printf '%s' "$OTEL_JOB_ID-<step name>-s" | sha256sum | cut -c17-32)-01"
docker compose up -d
```

The step name must match the step's `name:` exactly.
