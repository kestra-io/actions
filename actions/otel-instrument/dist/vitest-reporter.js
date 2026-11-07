import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'crypto';

function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}
function stepSpanId(jobId, stepName) {
  return sha256hex(`${jobId}-${stepName}-s`).slice(16, 32);
}

const VITEST_SPANS_DIR_ENV = "OTEL_VITEST_SPANS_DIR";
const newSpanId = () => randomBytes(8).toString("hex");
function resolveParent(env) {
  if (env.OTEL_STEP_NAME && env.OTEL_JOB_ID && env.OTEL_TRACE_ID) {
    return { traceId: env.OTEL_TRACE_ID, spanId: stepSpanId(env.OTEL_JOB_ID, env.OTEL_STEP_NAME) };
  }
  const parts = (env.TRACEPARENT ?? "").split("-");
  if (parts.length >= 3 && parts[0] === "00") return { traceId: parts[1], spanId: parts[2] };
  return null;
}
function conclusionOf(state) {
  if (state === "passed") return "success";
  if (state === "failed") return "failure";
  if (state === "skipped") return "skipped";
  return null;
}
class OtelVitestReporter {
  runStart = Date.now();
  moduleTimes = /* @__PURE__ */ new Map();
  onTestRunStart() {
    this.runStart = Date.now();
  }
  onTestModuleStart(module) {
    this.moduleTimes.set(module.moduleId, { start: Date.now() });
  }
  onTestModuleEnd(module) {
    const times = this.moduleTimes.get(module.moduleId);
    if (times) times.end = Date.now();
  }
  onTestRunEnd(modules, _errors, reason) {
    const dir = process.env[VITEST_SPANS_DIR_ENV];
    const parent = resolveParent(process.env);
    if (!dir || !parent) return;
    const runEnd = Date.now();
    const runSpanId = newSpanId();
    const projects = [...new Set(modules.map((m) => m.project.name).filter(Boolean))];
    const spans = [
      {
        name: projects.length ? `vitest ${projects.join(" ")}` : "vitest",
        spanId: runSpanId,
        parentSpanId: parent.spanId,
        startMs: this.runStart,
        endMs: runEnd,
        conclusion: reason === "failed" ? "failure" : reason === "passed" ? "success" : null,
        attributes: { "telemetry.source": "vitest", "vitest.run.reason": reason }
      }
    ];
    for (const module of modules) {
      const file = module.relativeModuleId ?? module.moduleId;
      const times = this.moduleTimes.get(module.moduleId);
      const moduleSpanId = newSpanId();
      spans.push({
        name: file,
        spanId: moduleSpanId,
        parentSpanId: runSpanId,
        startMs: times?.start ?? this.runStart,
        endMs: times?.end ?? runEnd,
        conclusion: conclusionOf(module.state()),
        attributes: { "telemetry.source": "vitest", "test.project": module.project.name, "test.file": file }
      });
      for (const test of module.children.allTests()) {
        const diagnostic = test.diagnostic();
        if (!diagnostic) continue;
        const result = test.result();
        const attributes = {
          "telemetry.source": "vitest",
          "test.project": module.project.name,
          "test.file": file,
          "test.name": test.fullName,
          "test.result": result.state,
          "test.retry_count": diagnostic.retryCount,
          "test.flaky": diagnostic.flaky
        };
        const error = result.errors?.[0]?.message;
        if (error) attributes["test.error"] = error.slice(0, 4096);
        spans.push({
          name: `${file} > ${test.fullName}`,
          spanId: newSpanId(),
          parentSpanId: moduleSpanId,
          startMs: diagnostic.startTime,
          endMs: diagnostic.startTime + diagnostic.duration,
          conclusion: conclusionOf(result.state),
          attributes
        });
      }
    }
    const record = { traceId: parent.traceId, spans };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `vitest-${process.pid}-${runEnd}.json`), JSON.stringify(record));
  }
}

export { VITEST_SPANS_DIR_ENV, OtelVitestReporter as default, resolveParent };
