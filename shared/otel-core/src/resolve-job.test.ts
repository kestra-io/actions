import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listJobs, resolveJob, resolveJobId, runnerEnvironmentOf, type WorkflowJob } from './resolve-job.js'

test('runnerEnvironmentOf reads "self-hosted" off the job\'s own labels', () => {
  assert.equal(runnerEnvironmentOf({ labels: ['self-hosted', 'linux'] }), 'self-hosted')
})

test('runnerEnvironmentOf defaults to "github-hosted" when the label is absent', () => {
  assert.equal(runnerEnvironmentOf({ labels: ['ubuntu-latest'] }), 'github-hosted')
})

function job(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: 1,
    name: 'test',
    workflow_name: 'CI',
    status: 'in_progress',
    conclusion: null,
    runner_name: null,
    labels: ['ubuntu-latest'],
    started_at: null,
    completed_at: null,
    ...overrides
  }
}

function fakeOctokit(jobs: WorkflowJob[]): Parameters<typeof listJobs>[0] {
  return {
    paginate: async () => jobs,
    rest: { actions: { listJobsForWorkflowRunAttempt: {} } }
  } as unknown as Parameters<typeof listJobs>[0]
}

test('listJobs paginates the Jobs API for the given run/attempt', async () => {
  const jobs = [job({ id: 1 }), job({ id: 2 })]
  const octokit = fakeOctokit(jobs)
  const result = await listJobs(octokit, 'owner', 'repo', 123, 1)
  assert.deepEqual(result, jobs)
})

test('resolveJob matches the in-progress job whose runner_name equals RUNNER_NAME', async () => {
  const prev = process.env.RUNNER_NAME
  try {
    process.env.RUNNER_NAME = 'runner-a'
    const jobs = [
      job({ id: 1, runner_name: 'runner-a' }),
      job({ id: 2, runner_name: 'runner-b' })
    ]
    const result = await resolveJob(fakeOctokit(jobs), 'owner', 'repo', 123, 1)
    assert.equal(result?.id, 1)
  } finally {
    if (prev === undefined) delete process.env.RUNNER_NAME
    else process.env.RUNNER_NAME = prev
  }
})

test('resolveJob falls back to the single in-progress job when RUNNER_NAME does not match', async () => {
  const prev = process.env.RUNNER_NAME
  try {
    delete process.env.RUNNER_NAME
    const jobs = [job({ id: 7, status: 'in_progress' }), job({ id: 8, status: 'completed' })]
    const result = await resolveJob(fakeOctokit(jobs), 'owner', 'repo', 123, 1)
    assert.equal(result?.id, 7)
  } finally {
    if (prev === undefined) delete process.env.RUNNER_NAME
    else process.env.RUNNER_NAME = prev
  }
})

test('resolveJobId returns just the numeric id of the resolved job', async () => {
  const jobs = [job({ id: 42, status: 'in_progress' })]
  const id = await resolveJobId(fakeOctokit(jobs), 'owner', 'repo', 123, 1)
  assert.equal(id, 42)
})
