import * as core from '@actions/core'
import type { GitHub } from '@actions/github/lib/utils'

type Octokit = InstanceType<typeof GitHub>

export interface WorkflowJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  runner_name: string | null
  // The `runs-on` labels for this job. GitHub requires "self-hosted" to be one of
  // them for a self-hosted runner (https://docs.github.com/actions/using-jobs/choosing-the-runner-for-a-job),
  // so this is how we tell a job's runner flavour apart per-job — see runnerEnvironmentOf().
  labels: string[]
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

/**
 * "github-hosted" or "self-hosted" for this specific job, matching the values
 * GitHub's own RUNNER_ENVIRONMENT env var takes — but derived from the job's own
 * API data instead of the current process's env var, since callers building
 * telemetry on behalf of a job other than the one they're running in (the
 * export-all aggregation job) can't rely on their own RUNNER_ENVIRONMENT matching.
 */
export function runnerEnvironmentOf(job: Pick<WorkflowJob, 'labels'>): string {
  return job.labels.includes('self-hosted') ? 'self-hosted' : 'github-hosted'
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
