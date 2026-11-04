import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gitRefPath, type Lookups, resolveOssRef } from './resolve.js'

const OSS_BRANCHES = ['develop', 'A1', 'A2', 'A3', 'Z', 'releases/v1.3.x']

// Open EE pull requests, head -> base.
const EE_PRS: Record<string, string> = {
  A1: 'develop',
  B1: 'A1',
  A3: 'B1',
  B2: 'A3',
  B3: 'B2',
  C1: 'B1',
  D1: 'develop',
  R1: 'releases/v1.3.x',
  R2: 'R1'
}

function lookups(ossBranches: string[], eePrs: Record<string, string>, calls: string[] = []): Lookups {
  return {
    ossHas: async (ref) => {
      calls.push(ref)
      return ossBranches.includes(ref)
    },
    openPrBase: async (head) => eePrs[head]
  }
}

const EXAMPLE = [
  { branch: 'A1', walk: ['A1'], ref: 'A1' },
  { branch: 'B1', walk: ['B1', 'A1'], ref: 'A1' },
  { branch: 'A3', walk: ['A3'], ref: 'A3' },
  { branch: 'B2', walk: ['B2', 'A3'], ref: 'A3' },
  { branch: 'B3', walk: ['B3', 'B2', 'A3'], ref: 'A3' },
  { branch: 'C1', walk: ['C1', 'B1', 'A1'], ref: 'A1' },
  { branch: 'D1', walk: ['D1', 'develop'], ref: 'develop' },
  { branch: 'R2', walk: ['R2', 'R1', 'releases/v1.3.x'], ref: 'releases/v1.3.x' }
]

for (const { branch, walk, ref } of EXAMPLE) {
  test(`pull request on ${branch} walks ${walk.join(' -> ')} and builds against OSS ${ref}`, async () => {
    const result = await resolveOssRef(branch, EE_PRS[branch], lookups(OSS_BRANCHES, EE_PRS))

    assert.deepEqual(result, { ref, sameName: branch === ref, walk })
  })
}

test('the direct base comes from the event payload, not from a pull request lookup on the head', async () => {
  // GitHub reports a stacked pull request's github.base_ref as the stack root, so the caller passes
  // the payload's base.ref, which can differ from what an API lookup of the head would return.
  const result = await resolveOssRef('B1', 'A1', lookups(OSS_BRANCHES, { B1: 'develop' }))

  assert.equal(result.ref, 'A1')
})

test('an ancestor without an OSS twin and without an open pull request ends the walk on develop', async () => {
  const result = await resolveOssRef('B3', 'B2', lookups(OSS_BRANCHES, { B3: 'B2' }))

  assert.deepEqual(result, { ref: 'develop', sameName: false, walk: ['B3', 'B2'] })
})

test('a cycle in the pull request bases falls back to develop', async () => {
  const result = await resolveOssRef('X', 'Y', lookups(OSS_BRANCHES, { X: 'Y', Y: 'X' }))

  assert.deepEqual(result, { ref: 'develop', sameName: false, walk: ['X', 'Y'] })
})

test('a stack deeper than the hop limit falls back to develop', async () => {
  const prs: Record<string, string> = {}
  for (let i = 0; i < 30; i++) prs[`S${i}`] = `S${i + 1}`
  const calls: string[] = []

  const result = await resolveOssRef('S0', 'S1', lookups(OSS_BRANCHES, prs, calls))

  assert.equal(result.ref, 'develop')
  assert.equal(calls.length, 20)
})

test('a push without a pull request uses the same-name OSS ref, else develop', async () => {
  const oss = [...OSS_BRANCHES, 'refs/tags/v1.3.0']

  assert.equal((await resolveOssRef('refs/tags/v1.3.0', undefined, lookups(oss, {}))).ref, 'refs/tags/v1.3.0')
  assert.deepEqual(await resolveOssRef('refs/heads/ee-only', undefined, lookups(oss, { 'refs/heads/ee-only': 'A1' })), {
    ref: 'develop',
    sameName: false,
    walk: ['refs/heads/ee-only']
  })
})

test('a pull request branch name maps to its heads/ ref and a push ref keeps its own namespace', () => {
  assert.equal(gitRefPath('fix/approval-bulk-cancel-marker'), 'heads/fix/approval-bulk-cancel-marker')
  assert.equal(gitRefPath('refs/heads/develop'), 'heads/develop')
  assert.equal(gitRefPath('refs/tags/v1.3.0'), 'tags/v1.3.0')
})
