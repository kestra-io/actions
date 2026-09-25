import { existsSync } from 'node:fs'
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

/**
 * Resolves a JaCoCo package + file name to an actual repo path by checking every conventional Gradle
 * source root under the module. Falls back to `<module>/<package>/<file>` when none exists on disk —
 * a best guess that still carries the right module and language even though the exact path may be a
 * generated source directory this does not know about.
 */
export function resolveJacocoPath(
  moduleRoot: string,
  packageName: string,
  fileName: string,
  workspace: string,
  exists: (file: string) => boolean = existsSync
): string | undefined {
  for (const sourceRoot of SOURCE_ROOTS) {
    const candidate = path.join(moduleRoot, sourceRoot, packageName, fileName)
    if (exists(candidate)) return toRepoPath(candidate, workspace)
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
  exists: (file: string) => boolean = existsSync
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
      const path_ = resolveJacocoPath(moduleRoot, packageName, fileName, workspace, exists)
      if (!path_) continue

      const counters = source.counter ?? []
      const lines = counterOf(counters, 'LINE')
      if (!lines) continue

      files.push({ path: path_, format: 'jacoco', lines, branches: counterOf(counters, 'BRANCH'), functions: counterOf(counters, 'METHOD') })
    }
  }

  return files
}
