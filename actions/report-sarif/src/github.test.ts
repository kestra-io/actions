import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubMetadata, pullRequestNumber } from './github.js'

const pullRequestEnv = {
  GITHUB_REPOSITORY: 'kestra-io/kestra',
  GITHUB_REPOSITORY_ID: '138906404',
  GITHUB_REPOSITORY_OWNER: 'kestra-io',
  GITHUB_REPOSITORY_OWNER_ID: '59033362',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_SHA: '0f1e2d3c',
  GITHUB_REF: 'refs/pull/261/merge',
  GITHUB_REF_NAME: '261/merge',
  GITHUB_REF_TYPE: 'branch',
  GITHUB_BASE_REF: 'main',
  GITHUB_HEAD_REF: 'fix/opengrep',
  GITHUB_EVENT_NAME: 'pullRequest',
  GITHUB_WORKFLOW: 'Main',
  GITHUB_WORKFLOW_REF: 'kestra-io/kestra/.github/workflows/main.yml@refs/pull/261/merge',
  GITHUB_JOB: 'test',
  GITHUB_RUN_ID: '18234',
  GITHUB_RUN_NUMBER: '912',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_ACTOR: 'tchiotludo',
  GITHUB_ACTOR_ID: '2064609',
  GITHUB_TRIGGERING_ACTOR: 'tchiotludo',
  RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64',
  RUNNER_NAME: 'GitHub Actions 5',
  RUNNER_ENVIRONMENT: 'github-hosted'
}

test('reads the whole run context off the default environment', () => {
  const github = githubMetadata(pullRequestEnv)
  assert.equal(github.repository, 'kestra-io/kestra')
  assert.equal(github.repositoryOwner, 'kestra-io')
  assert.equal(github.eventName, 'pullRequest')
  assert.equal(github.baseRef, 'main')
  assert.equal(github.headRef, 'fix/opengrep')
  assert.equal(github.job, 'test')
  assert.equal(github.runNumber, 912)
  assert.equal(github.runAttempt, 1)
  assert.deepEqual(github.runner, { os: 'Linux', arch: 'X64', name: 'GitHub Actions 5', environment: 'github-hosted' })
})

test('links to the run, and to the attempt once there is more than one', () => {
  assert.equal(githubMetadata(pullRequestEnv).runUrl, 'https://github.com/kestra-io/kestra/actions/runs/18234')
  assert.equal(
    githubMetadata({ ...pullRequestEnv, GITHUB_RUN_ATTEMPT: '3' }).runUrl,
    'https://github.com/kestra-io/kestra/actions/runs/18234/attempts/3'
  )
})

test('resolves the pull request from the merge ref', () => {
  assert.deepEqual(githubMetadata(pullRequestEnv).pullRequest, {
    number: 261,
    url: 'https://github.com/kestra-io/kestra/pull/261'
  })
  assert.equal(pullRequestNumber('refs/pull/7/head'), 7)
  assert.equal(pullRequestNumber('refs/heads/main'), undefined)
  assert.equal(pullRequestNumber(''), undefined)
})

test('a push build carries no pull request', () => {
  const github = githubMetadata({ ...pullRequestEnv, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' })
  assert.equal(github.pullRequest, undefined)
})

test('an empty environment yields empty values rather than throwing', () => {
  const github = githubMetadata({})
  assert.equal(github.repository, '')
  assert.equal(github.runUrl, '')
  assert.equal(github.runAttempt, undefined)
  assert.equal(github.serverUrl, 'https://github.com')
})
