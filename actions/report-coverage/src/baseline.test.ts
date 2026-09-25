import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { artifactName, downloadBaseline, findBaselineRun, uploadBaseline, type ArtifactClient } from './baseline.js'
import type { CoverageSummary } from './summary.js'

const summary: CoverageSummary = {
  repository: 'kestra-io/kestra',
  component: 'backend',
  sha: 'abc',
  runId: '1',
  modules: { core: { lines: { covered: 8, missed: 2 } } },
  totals: { lines: { covered: 8, missed: 2 } }
}

test('artifactName scopes the artifact to its component', () => {
  assert.equal(artifactName('backend'), 'coverage-baseline-backend')
  assert.equal(artifactName('frontend'), 'coverage-baseline-frontend')
})

test('uploadBaseline writes the summary to disk and hands it to the artifact client', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coverage-'))
  try {
    const calls: unknown[] = []
    const client = {
      uploadArtifact: async (...args: unknown[]) => {
        calls.push(args)
        return {} as any
      }
    } as unknown as ArtifactClient
    await uploadBaseline(summary, 'backend', dir, client)
    assert.equal(calls.length, 1)
    const [name, files, root] = calls[0] as [string, string[], string]
    assert.equal(name, 'coverage-baseline-backend')
    assert.equal(root, dir)
    assert.deepEqual(JSON.parse(await readFile(files[0], 'utf8')), summary)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('findBaselineRun walks runs newest first and returns the one carrying the artifact', async () => {
  const octokit = {
    rest: {
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 2 }, { id: 1 }] } }),
        listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => ({
          data: { artifacts: run_id === 1 ? [{ name: 'coverage-baseline-backend', expired: false }] : [] }
        })
      }
    }
  } as any

  const runId = await findBaselineRun(octokit, 'kestra-io', 'kestra', 'tests.yml', 'develop', 'backend')
  assert.equal(runId, 1)
})

test('findBaselineRun returns undefined when no run carries the artifact', async () => {
  const octokit = {
    rest: { actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 1 }] } }), listWorkflowRunArtifacts: async () => ({ data: { artifacts: [] } }) } }
  } as any
  assert.equal(await findBaselineRun(octokit, 'kestra-io', 'kestra', 'tests.yml', 'develop', 'backend'), undefined)
})

test('downloadBaseline fetches by findBy and reads the summary back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coverage-'))
  try {
    const client = {
      getArtifact: async () => ({ artifact: { id: 7 } }),
      downloadArtifact: async (_id: number, options: { path: string }) => {
        await import('node:fs/promises').then(fs => fs.writeFile(path.join(options.path, 'coverage-summary.json'), JSON.stringify(summary)))
        return {} as any
      }
    } as unknown as ArtifactClient

    const downloaded = await downloadBaseline(9, 'backend', 'kestra-io', 'kestra', 'token', dir, client)
    assert.deepEqual(downloaded, summary)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
