import * as core from '@actions/core'
import type { GitHub } from '@actions/github/lib/utils.js'

type Octokit = InstanceType<typeof GitHub>

export interface WorkflowJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  runner_name: string | null
  started_at: string | null
  completed_at: string | null
  steps?: Array<{
    name: string
    status: string
    conclusion: string | null
    number: number
    started_at?: string | null
    completed_at?: string | null
  }>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function listJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  runAttempt: number
): Promise<WorkflowJob[]> {
  const jobs = (await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRunAttempt, {
    owner,
    repo,
    run_id: runId,
    attempt_number: runAttempt,
    per_page: 100
  })) as unknown as WorkflowJob[]
  return jobs
}

/**
 * Resolve the numeric id of the job this action is currently running in.
 *
 * The job id is not exposed as a default GitHub env var, so we list the jobs of
 * the current run attempt and match ours. Matrix jobs can share a name, so we
 * disambiguate on RUNNER_NAME among the in-progress jobs, retrying since the job
 * row can be momentarily absent from the API right after a job starts.
 */
export async function resolveJobId(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  runAttempt: number
): Promise<number | null> {
  const runnerName = process.env.RUNNER_NAME

  for (let attempt = 0; attempt < 5; attempt++) {
    const jobs = await listJobs(octokit, owner, repo, runId, runAttempt)
    const inProgress = jobs.filter((j) => j.status === 'in_progress')

    let match = runnerName ? inProgress.find((j) => j.runner_name === runnerName) : undefined
    if (!match && inProgress.length === 1) {
      match = inProgress[0]
    }
    if (match) {
      return match.id
    }

    core.debug(`Job id not resolvable yet (attempt ${attempt + 1}/5, ${inProgress.length} in progress)`)
    await sleep(2000 * (attempt + 1))
  }

  return null
}
