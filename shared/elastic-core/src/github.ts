/**
 * Everything the runner knows about the run that observed a finding, under one `github.` namespace.
 *
 * Follows how Elastic's own integrations shape a document: ECS fields on top, and every field the
 * source contributes below a single namespace named after it (`google_scc.asset.*`). Keeping the
 * CI context together rather than scattering it across `vcs.*`, `host.*` and the top level means a
 * Kibana filter on a finding's origin is one prefix, and nothing collides with ECS.
 *
 * Every value is read from the default environment variables, so this works in any workflow
 * without the caller wiring a `github` context expression into an input.
 */
export interface GithubMetadata {
  readonly repository: string
  readonly repositoryId: string
  readonly repositoryOwner: string
  readonly repositoryOwnerId: string
  readonly sha: string
  readonly ref: string
  readonly refName: string
  readonly refType: string
  readonly baseRef: string
  readonly headRef: string
  readonly eventName: string
  readonly workflow: string
  readonly workflowRef: string
  readonly job: string
  readonly runId: string
  readonly runNumber?: number
  readonly runAttempt?: number
  readonly runUrl: string
  readonly actor: string
  readonly actorId: string
  readonly triggeringActor: string
  readonly serverUrl: string
  readonly apiUrl: string
  readonly pullRequest?: { readonly number: number; readonly url: string }
  readonly runner: { readonly os: string; readonly arch: string; readonly name: string; readonly environment: string }
}

type Env = Record<string, string | undefined>

function count(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return value && Number.isFinite(parsed) ? parsed : undefined
}

/**
 * On a pull request the checked out ref is the merge ref, so the number is in it. Reading it from
 * there rather than from the event payload keeps this working for `pull_request_target` and for a
 * `workflow_run` re-run, where the payload is a different shape or absent.
 */
export function pullRequestNumber(ref: string): number | undefined {
  return count(/^refs\/pull\/(\d+)\//.exec(ref)?.[1])
}

export function githubMetadata(env: Env): GithubMetadata {
  const repository = env.GITHUB_REPOSITORY ?? ''
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com'
  const runId = env.GITHUB_RUN_ID ?? ''
  const attempt = count(env.GITHUB_RUN_ATTEMPT)
  const ref = env.GITHUB_REF ?? ''
  const pullRequest = pullRequestNumber(ref)

  const runUrl = repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : ''

  return {
    repository,
    repositoryId: env.GITHUB_REPOSITORY_ID ?? '',
    repositoryOwner: env.GITHUB_REPOSITORY_OWNER ?? '',
    repositoryOwnerId: env.GITHUB_REPOSITORY_OWNER_ID ?? '',
    sha: env.GITHUB_SHA ?? '',
    ref,
    refName: env.GITHUB_REF_NAME ?? '',
    refType: env.GITHUB_REF_TYPE ?? '',
    // Set only on a pull request, and the pair that says which branch a finding is being merged
    // into — the difference between "this is on main" and "this would land on main".
    baseRef: env.GITHUB_BASE_REF ?? '',
    headRef: env.GITHUB_HEAD_REF ?? '',
    eventName: env.GITHUB_EVENT_NAME ?? '',
    workflow: env.GITHUB_WORKFLOW ?? '',
    workflowRef: env.GITHUB_WORKFLOW_REF ?? '',
    job: env.GITHUB_JOB ?? '',
    runId: runId,
    runNumber: count(env.GITHUB_RUN_NUMBER),
    runAttempt: attempt,
    // A rerun keeps the run id, so the attempt has to be in the link or it opens the first attempt.
    runUrl: runUrl && attempt && attempt > 1 ? `${runUrl}/attempts/${attempt}` : runUrl,
    // actor is who the run is attributed to, triggeringActor is who pressed the button on a rerun.
    actor: env.GITHUB_ACTOR ?? '',
    actorId: env.GITHUB_ACTOR_ID ?? '',
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR ?? '',
    serverUrl: serverUrl,
    apiUrl: env.GITHUB_API_URL ?? '',
    pullRequest:
      pullRequest === undefined
        ? undefined
        : { number: pullRequest, url: repository ? `${serverUrl}/${repository}/pull/${pullRequest}` : '' },
    runner: {
      os: env.RUNNER_OS ?? '',
      arch: env.RUNNER_ARCH ?? '',
      name: env.RUNNER_NAME ?? '',
      // "github-hosted" or "self-hosted", so findings can be split by runner flavour.
      environment: env.RUNNER_ENVIRONMENT ?? ''
    }
  }
}
