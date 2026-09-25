# elastic-core

Single source of truth for the code shared by `actions/report-sarif` and
`actions/report-coverage`:

- `bulk.ts` — the Elastic Cloud managed `_bulk` input client: URL resolution,
  ndjson encoding, batching, retrying send, auth headers, data stream naming.
- `document.ts` — ECS document helpers: dotted-path assignment, metadata
  application, pruning empty fields.
- `language.ts` — the language/kind of a file, from its name.
- `github.ts` — everything the runner knows about the run, read from the
  default `GITHUB_*`/`RUNNER_*` environment variables.
- `inputs.ts` — the multi-line/comma-separated input parsing shared by every
  action here.

This is **not** a GitHub Action — no `action.yml`, no `dist/`. It is imported
by relative path (e.g. `../../../shared/elastic-core/src/bulk.js`) directly
from each action's own source, and bundled into each action's own
`dist/index.js` by that action's own `rollup` build. Do not copy these files
into an action's `src/` — import them, so a change here reaches every
consumer the next time each is rebuilt.

`npm install` here is required so that Node's module resolution can find
`@actions/core` when an action's `tsc --noEmit` type-checks a file physically
located in this directory — Node/TypeScript resolve bare specifiers by
walking up from the *importing file's own directory*, not from the consuming
action's directory.

```bash
npm install
npm test        # unit tests for bulk/document/language/github/inputs
npm run typecheck
```
