# otel-core

Single source of truth for the code shared by `actions/otel-instrument` and
`actions/otel-export-trace`:

- `ids.ts` — deterministic trace/span id computation (must byte-for-byte match
  the OpenTelemetry Collector `githubreceiver` scheme; both actions depend on
  computing the exact same ids so their spans nest in one trace).
- `otlp.ts` — OTLP resource/span/log-record builders and the gRPC exporters.
- `resolve-job.ts` — GitHub Actions Jobs API client.

This is **not** a GitHub Action — no `action.yml`, no `dist/`. It is imported
by relative path (e.g. `../../../shared/otel-core/src/ids.js`) directly from
each action's own source, and bundled into each action's own `dist/index.js`
by that action's own `rollup` build. Do not copy these files into an action's
`src/` — import them, so a change here reaches both actions the next time
each is rebuilt.

`npm install` here is required (even though nothing in this directory is
published or bundled standalone) so that Node's module resolution can find
`@actions/github` etc. when either action's `tsc --noEmit` type-checks a file
physically located in this directory — Node/TypeScript resolve bare
specifiers by walking up from the *importing file's own directory*, not from
the consuming action's directory.

```bash
npm install
npm test        # unit tests for ids/otlp/resolve-job
npm run typecheck
```
