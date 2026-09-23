import * as core from '@actions/core'
import * as github from '@actions/github'
import { annotationBatches, type Annotation } from './annotations.js'

export interface CheckRunOptions {
  readonly token: string
  readonly name: string
  readonly title: string
  readonly summary: string
  readonly annotations: Annotation[]
  readonly conclusion: 'success' | 'failure' | 'neutral'
}

/**
 * Publish findings as a check run.
 *
 * This replaces the usual reviewdog hop. reviewdog's github-pr-review reporter — the one already
 * used for eslint in this repository — drops every finding on a non-pull-request build, and the
 * `::warning` workflow command it would otherwise fall back to is capped at 10 per step. A check
 * run is what lifts that ceiling, and creating it directly is both fewer moving parts and one
 * less binary to download.
 */
export async function publishCheckRun(options: CheckRunOptions): Promise<void> {
  const octokit = github.getOctokit(options.token)
  const { owner, repo } = github.context.repo

  // On a pull_request event the workflow runs against a synthetic merge commit, which is not the
  // head the pull request is showing; annotations attached to it are not rendered on the diff.
  const headSha = github.context.payload.pull_request?.head?.sha ?? github.context.sha

  const batches = annotationBatches(options.annotations)
  const [first, ...rest] = batches

  const created = await octokit.rest.checks.create({
    owner,
    repo,
    name: options.name,
    head_sha: headSha,
    status: 'completed',
    conclusion: options.conclusion,
    output: {
      title: options.title,
      summary: options.summary,
      annotations: first
    }
  })

  for (const batch of rest) {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: created.data.id,
      output: { title: options.title, summary: options.summary, annotations: batch }
    })
  }

  core.info(`Published ${options.annotations.length} annotation(s) to check run "${options.name}".`)
}
