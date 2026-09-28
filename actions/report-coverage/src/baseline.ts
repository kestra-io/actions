import { DefaultArtifactClient } from '@actions/artifact'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type * as github from '@actions/github'
import type { CoverageSummary } from './summary.js'

type Octokit = ReturnType<typeof github.getOctokit>

/** One stream per component, so a monorepo's backend and frontend coverage don't overwrite each other. */
export function artifactName(component: string): string {
  return `coverage-baseline-${component}`
}

export interface ArtifactClient {
  uploadArtifact: DefaultArtifactClient['uploadArtifact']
  getArtifact: DefaultArtifactClient['getArtifact']
  downloadArtifact: DefaultArtifactClient['downloadArtifact']
}

/** Uploaded on every run of `base-branch`, so a PR always compares against the latest develop run. */
export async function uploadBaseline(
  summary: CoverageSummary,
  component: string,
  tempDir: string,
  client: ArtifactClient = new DefaultArtifactClient()
): Promise<void> {
  const file = path.join(tempDir, 'coverage-summary.json')
  await fs.writeFile(file, JSON.stringify(summary))
  await client.uploadArtifact(artifactName(component), [file], tempDir, { retentionDays: 90 })
}

/**
 * Finds develop's last known coverage by walking recent successful runs of the same workflow file on
 * `base-branch`, newest first, until one carries the artifact. The Elastic `_bulk` input
 * `report-coverage` ships to is write-only, so this is the only place develop's coverage can be read
 * back from.
 *
 * Not filtered by event: uploadBaseline runs on any trigger that lands on base-branch — a plain
 * push, but also a manual `workflow_dispatch` release build or a scheduled run — so restricting the
 * lookup to `event: push` would miss a baseline that a workflow_dispatch run genuinely uploaded.
 */
export async function findBaselineRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowFile: string,
  baseBranch: string,
  component: string,
  maxRuns = 20
): Promise<number | undefined> {
  const name = artifactName(component)
  const runs = await octokit.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: workflowFile, branch: baseBranch, status: 'success', per_page: maxRuns
  })
  for (const run of runs.data.workflow_runs) {
    const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({ owner, repo, run_id: run.id })
    if (artifacts.data.artifacts.some(found => found.name === name && !found.expired)) return run.id
  }
  return undefined
}

export async function downloadBaseline(
  runId: number,
  component: string,
  owner: string,
  repo: string,
  token: string,
  tempDir: string,
  client: ArtifactClient = new DefaultArtifactClient()
): Promise<CoverageSummary> {
  const findBy = { token, workflowRunId: runId, repositoryOwner: owner, repositoryName: repo }
  const { artifact } = await client.getArtifact(artifactName(component), { findBy })
  await client.downloadArtifact(artifact.id, { path: tempDir, findBy })
  const raw = await fs.readFile(path.join(tempDir, 'coverage-summary.json'), 'utf8')
  return JSON.parse(raw) as CoverageSummary
}
