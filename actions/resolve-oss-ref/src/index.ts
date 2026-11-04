import * as core from '@actions/core'
import * as github from '@actions/github'
import { gitRefPath, resolveOssRef } from './resolve.js'

const OSS = { owner: 'kestra-io', repo: 'kestra' }

async function run(): Promise<void> {
  const octokit = github.getOctokit(core.getInput('github-token', { required: true }))
  const { owner, repo } = github.context.repo
  const pullRequest = github.context.payload.pull_request
  // The payload's base, not github.base_ref: on a stacked pull request the latter is the stack root.
  const head: string = pullRequest ? pullRequest.head.ref : github.context.ref
  const base: string | undefined = pullRequest ? pullRequest.base.ref : undefined

  const result = await resolveOssRef(head, base, {
    ossHas: async (ref) => {
      try {
        await octokit.rest.git.getRef({ ...OSS, ref: gitRefPath(ref) })
        return true
      } catch (e) {
        if ((e as { status?: number }).status === 404) return false
        throw e
      }
    },
    openPrBase: async (branch) => {
      const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}` })
      if (data.length > 1) {
        core.warning(`${data.length} open pull requests have ${branch} as head, following #${data[0].number}`)
      }
      return data[0]?.base.ref
    }
  })

  core.info(`Walked ${result.walk.join(' -> ')}, using OSS ${result.ref}`)
  core.setOutput('ref', result.ref)
  core.setOutput('same-name', String(result.sameName))
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)))
