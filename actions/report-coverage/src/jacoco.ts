import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { toRepoPath } from './paths.js'
import type { Counter, FileCoverage } from './model.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: name => ['package', 'sourcefile', 'counter'].includes(name) })

const BUILD_MARKERS = ['build.gradle', 'build.gradle.kts', 'pom.xml']

const SOURCE_ROOTS = [
  'src/main/java', 'src/main/kotlin', 'src/main/groovy', 'src/main/scala',
  'src/test/java', 'src/test/kotlin', 'src/test/groovy', 'src/test/scala',
  'src/java', 'src/kotlin'
]

interface JacocoCounter {
  '@_type'?: string
  '@_covered'?: string
  '@_missed'?: string
}

interface JacocoSourcefile {
  '@_name'?: string
  counter?: JacocoCounter[]
}

interface JacocoPackage {
  '@_name'?: string
  sourcefile?: JacocoSourcefile[]
}

interface JacocoDoc {
  report?: { package?: JacocoPackage[] }
}

function counterOf(counters: JacocoCounter[], type: string): Counter | undefined {
  const found = counters.find(counter => counter['@_type'] === type)
  if (!found) return undefined
  return { covered: Number(found['@_covered'] ?? 0), missed: Number(found['@_missed'] ?? 0) }
}

/**
 * The Gradle/Maven module a report file belongs to: the nearest ancestor with a build file. JaCoCo
 * itself has no notion of module — its report only names a package and a file — so this is what lets
 * a monorepo attribute `core/src/main/java/io/kestra/Foo.java` to `core` rather than the repo root.
 */
export function findModuleRoot(reportFile: string, workspace: string, exists: (file: string) => boolean = existsSync): string {
  let dir = path.dirname(reportFile)
  const root = path.resolve(workspace)
  while (dir.startsWith(root)) {
    if (BUILD_MARKERS.some(marker => exists(path.join(dir, marker)))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return root
}

function trySourceRoots(
  moduleRoot: string,
  packageName: string,
  fileName: string,
  workspace: string,
  exists: (file: string) => boolean
): string | undefined {
  for (const sourceRoot of SOURCE_ROOTS) {
    const candidate = path.join(moduleRoot, sourceRoot, packageName, fileName)
    if (exists(candidate)) return toRepoPath(candidate, workspace)
  }
  return undefined
}

/**
 * Direct children of the workspace root that look like a Gradle/Maven module — a candidate list for
 * when the report itself does not sit under the module it describes (see below).
 */
function siblingModules(workspace: string, exists: (file: string) => boolean, list: (dir: string) => string[]): string[] {
  let entries: string[]
  try {
    entries = list(workspace)
  } catch {
    return []
  }
  return entries.map(name => path.join(workspace, name)).filter(dir => BUILD_MARKERS.some(marker => exists(path.join(dir, marker))))
}

/**
 * Resolves a JaCoCo package + file name to an actual repo path by checking every conventional Gradle
 * source root, first under the report's own module and then, if that finds nothing, under every
 * other module in the workspace.
 *
 * The second pass exists because of Gradle's `jacoco-report-aggregation` plugin: it writes one
 * combined `testCodeCoverageReport.xml` at the *repository* root covering every subproject, so
 * `findModuleRoot` — which only looks at where the report file itself sits — resolves that report's
 * "module" to the root, not to whichever subproject each package actually belongs to. Searching every
 * sibling module's source roots for the same package + file name is what recovers the real module in
 * that case. Only sibling directories directly under the workspace are tried, not nested ones — every
 * repository this actions/report-coverage runs against keeps its modules one level deep.
 *
 * Falls back to `<module>/<package>/<file>` when nothing exists on disk anywhere — a best guess that
 * still carries a module and a language even though the exact path may be a generated source
 * directory this does not know about.
 */
export function resolveJacocoPath(
  moduleRoot: string,
  packageName: string,
  fileName: string,
  workspace: string,
  exists: (file: string) => boolean = existsSync,
  list: (dir: string) => string[] = readdirSync
): string | undefined {
  const direct = trySourceRoots(moduleRoot, packageName, fileName, workspace, exists)
  if (direct) return direct

  for (const candidate of siblingModules(workspace, exists, list)) {
    if (candidate === moduleRoot) continue
    const found = trySourceRoots(candidate, packageName, fileName, workspace, exists)
    if (found) return found
  }

  return toRepoPath(path.join(moduleRoot, packageName, fileName), workspace)
}

/**
 * JaCoCo's own XML report (`jacocoTestReport.xml` / `testCodeCoverageReport.xml`): `<package>` groups
 * `<sourcefile>`, each carrying one `<counter>` per kind (LINE, BRANCH, METHOD, ...). Package names use
 * `/` as separator, matching the file system layout of the source it was compiled from.
 */
export function parseJacoco(
  content: string,
  reportFile: string,
  workspace: string,
  exists: (file: string) => boolean = existsSync,
  list: (dir: string) => string[] = readdirSync
): FileCoverage[] {
  const doc = parser.parse(content) as JacocoDoc
  const packages = doc.report?.package ?? []
  if (packages.length === 0) return []

  const moduleRoot = findModuleRoot(reportFile, workspace, exists)
  const files: FileCoverage[] = []

  for (const pkg of packages) {
    const packageName = pkg['@_name'] ?? ''
    for (const source of pkg.sourcefile ?? []) {
      const fileName = source['@_name']
      if (!fileName) continue
      const path_ = resolveJacocoPath(moduleRoot, packageName, fileName, workspace, exists, list)
      if (!path_) continue

      const counters = source.counter ?? []
      const lines = counterOf(counters, 'LINE')
      if (!lines) continue

      files.push({ path: path_, format: 'jacoco', lines, branches: counterOf(counters, 'BRANCH'), functions: counterOf(counters, 'METHOD') })
    }
  }

  return files
}
