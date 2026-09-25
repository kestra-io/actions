import * as path from 'node:path'
import { applyMetadata, prune, sha256 } from '../../../shared/elastic-core/src/document.js'
import type { GithubMetadata } from '../../../shared/elastic-core/src/github.js'
import { languageOf } from '../../../shared/elastic-core/src/language.js'
import { pct } from './model.js'
import type { Counter, FileCoverage } from './model.js'

export interface DocumentContext {
  readonly component: string
  readonly namespace: string
  readonly github: GithubMetadata
  readonly scanTime: string
  readonly tags: string[]
  readonly metadata: Record<string, string>
}

function counterFields(counter: Counter | undefined): Record<string, unknown> | undefined {
  if (!counter) return undefined
  return { covered: counter.covered, missed: counter.missed, total: counter.covered + counter.missed, pct: pct(counter) }
}

/**
 * One document per source file — the granularity a Kibana treemap needs to group by module then
 * directory then file. `pct` is written for display only; a rollup must sum `covered`/`total` and
 * divide, or a module's percentage would average its files' percentages instead of weighting them
 * by size.
 */
export function toDocument(file: FileCoverage & { readonly module: string }, context: DocumentContext): Record<string, unknown> {
  const github = context.github
  const repository = github.repository
  const repositoryUrl = repository ? `${github.serverUrl}/${repository}` : undefined
  const id = sha256([repository, context.component, github.sha, file.path].join('|'))

  const document: Record<string, unknown> = {
    '@timestamp': context.scanTime,
    tags: context.tags,
    data_stream: { type: 'logs', dataset: 'coverage', namespace: context.namespace },
    ecs: { version: '8.11.0' },
    event: {
      kind: 'metric',
      category: [],
      type: ['info'],
      dataset: 'coverage',
      module: 'coverage',
      provider: 'github-actions',
      id,
      created: context.scanTime,
      sequence: Number(github.runId) || undefined
    },
    message: `${file.path}: ${pct(file.lines)}% line coverage`,
    coverage: {
      component: context.component,
      format: file.format,
      module: file.module,
      lines: counterFields(file.lines),
      branches: counterFields(file.branches),
      functions: counterFields(file.functions)
    },
    file: { path: file.path, name: path.basename(file.path), directory: path.dirname(file.path), extension: path.extname(file.path).replace(/^\./, '') },
    code: { language: languageOf(file.path) },
    resource: {
      id: sha256(`${repository}|${context.component}|${file.path}`).slice(0, 32),
      name: file.path,
      type: 'file',
      sub_type: languageOf(file.path),
      path: file.path,
      module: file.module,
      repository,
      repository_url: repositoryUrl,
      url: repository && github.sha ? `${repositoryUrl}/blob/${github.sha}/${file.path}` : undefined
    },
    organization: { name: github.repositoryOwner, id: github.repositoryOwnerId },
    user: { name: github.triggeringActor || github.actor, id: github.actorId },
    github: structuredClone(github) as unknown as Record<string, unknown>
  }

  applyMetadata(document, context.metadata)
  return prune(document)
}
