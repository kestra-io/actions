import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'

/**
 * A Gradle init script (auto-applied from $GRADLE_USER_HOME/init.d) that traces
 * the build itself: a span per task and a span per JUnit test, parented under the
 * GitHub step span via the TRACEPARENT env var, exported over OTLP/gRPC.
 *
 * It runs in the Gradle daemon JVM — NOT the forked test workers — so it does not
 * touch the application-under-test's OpenTelemetry (no resetForTest conflict).
 * Everything is read from the OTEL_* / TRACEPARENT env the action already exports,
 * so the script is fully static.
 */
const INIT_SCRIPT = String.raw`import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.SpanContext
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.api.trace.TraceFlags
import io.opentelemetry.api.trace.TraceState
import io.opentelemetry.context.Context
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter
import io.opentelemetry.sdk.resources.Resource
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

initscript {
  repositories { mavenCentral() }
  dependencies {
    classpath "io.opentelemetry:opentelemetry-sdk:1.43.0"
    classpath "io.opentelemetry:opentelemetry-exporter-otlp:1.43.0"
    // OtlpGrpcSpanExporter references io.grpc.ManagedChannel (deprecated setChannel),
    // so grpc-api must be on the classpath to load the class even though the actual
    // transport goes over the bundled okhttp sender.
    classpath "io.grpc:grpc-api:1.68.1"
  }
}

def endpoint = System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
if (endpoint == null || endpoint.trim().isEmpty()) {
  return
}

def serviceName = System.getenv("OTEL_SERVICE_NAME") ?: "gradle-build"
def traceparent = System.getenv("TRACEPARENT")
def headersEnv = System.getenv("OTEL_EXPORTER_OTLP_HEADERS") ?: ""
def runId = System.getenv("GITHUB_RUN_ID")
def instanceId = runId ? (runId + "-" + (System.getenv("GITHUB_RUN_ATTEMPT") ?: "1")) : (System.getenv("RUNNER_NAME") ?: "github-actions")

def exporterBuilder = OtlpGrpcSpanExporter.builder().setEndpoint(endpoint)
headersEnv.split(",").each { pair ->
  def t = pair.trim()
  if (!t.isEmpty()) {
    def idx = t.indexOf("=")
    if (idx > 0) exporterBuilder.addHeader(t.substring(0, idx).trim(), t.substring(idx + 1).trim())
  }
}
def exporter = exporterBuilder.build()

def resource = Resource.getDefault().merge(
  Resource.create(Attributes.builder().put("service.name", serviceName).put("service.instance.id", instanceId).build()))

def tracerProvider = SdkTracerProvider.builder()
  .addSpanProcessor(BatchSpanProcessor.builder(exporter).setScheduleDelay(2, TimeUnit.SECONDS).build())
  .setResource(resource)
  .build()
def tracer = tracerProvider.get("kestra-otel-collect-gradle")

// Nest the build under the GitHub step span carried in TRACEPARENT.
def parentContext = Context.root()
if (traceparent != null && traceparent.startsWith("00-")) {
  def p = traceparent.split("-")
  if (p.length >= 3) {
    def sc = SpanContext.createFromRemoteParent(p[1], p[2], TraceFlags.getSampled(), TraceState.getDefault())
    parentContext = Context.root().with(Span.wrap(sc))
  }
}

def buildSpan = tracer.spanBuilder("gradle " + gradle.startParameter.taskNames.join(" "))
  .setParent(parentContext).setSpanKind(SpanKind.INTERNAL).startSpan()
def buildContext = parentContext.with(buildSpan)

def taskStarts = new ConcurrentHashMap<String, Long>()
gradle.taskGraph.beforeTask { task -> taskStarts.put(task.path, System.currentTimeMillis()) }
gradle.taskGraph.afterTask { task ->
  def start = taskStarts.remove(task.path)
  if (start == null) return
  def span = tracer.spanBuilder(task.path).setParent(buildContext)
    .setStartTimestamp(Instant.ofEpochMilli(start)).startSpan()
  span.setAttribute("gradle.task.path", task.path)
  span.setAttribute("gradle.task.did_work", task.state.didWork)
  def failure = task.state.failure
  if (failure != null) span.setStatus(StatusCode.ERROR, String.valueOf(failure.message))
  span.end(Instant.now())
}

// A span per JUnit test, from Gradle's own test events.
allprojects { prj ->
  prj.tasks.withType(Test).configureEach { testTask ->
    testTask.afterTest { desc, result ->
      def name = (desc.className ? desc.className + "#" : "") + desc.name
      def span = tracer.spanBuilder(name).setParent(buildContext)
        .setStartTimestamp(Instant.ofEpochMilli(result.startTime)).startSpan()
      span.setAttribute("test.class", String.valueOf(desc.className))
      span.setAttribute("test.name", String.valueOf(desc.name))
      span.setAttribute("test.result", String.valueOf(result.resultType))
      if (result.resultType.toString() == "FAILURE") {
        def ex = result.exception
        span.setStatus(StatusCode.ERROR, ex != null ? String.valueOf(ex.message) : "test failed")
      }
      span.end(Instant.ofEpochMilli(result.endTime))
    }
  }
}

gradle.buildFinished {
  buildSpan.end()
  tracerProvider.forceFlush().join(30, TimeUnit.SECONDS)
  tracerProvider.shutdown().join(10, TimeUnit.SECONDS)
}
`

/** Resolve the Gradle user home the build will use (matches the default the runner uses). */
function gradleUserHome(): string {
  return process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle')
}

/**
 * Install the tracing init script into $GRADLE_USER_HOME/init.d so every later
 * `gradle`/`./gradlew` invocation in the job is traced without any build.gradle change.
 */
export function installGradleInitScript(): string {
  const initDir = path.join(gradleUserHome(), 'init.d')
  fs.mkdirSync(initDir, { recursive: true })
  const scriptPath = path.join(initDir, 'otel-collect.gradle')
  fs.writeFileSync(scriptPath, INIT_SCRIPT)
  core.info(`Installed Gradle tracing init script: ${scriptPath}`)
  return scriptPath
}
