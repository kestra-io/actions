import * as core from '@actions/core'
import * as exec from '@actions/exec'

async function git(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = ''
  const code = await exec.exec('git', args, {
    ignoreReturnCode: true,
    silent: true,
    listeners: { stdout: (data: Buffer) => { stdout += data.toString() } }
  })
  return { code, stdout: stdout.trim() }
}

export interface BaselineContext {
  readonly baseRef?: string
  readonly baseSha?: string
}

/**
 * Resolve the commit `--baseline-commit` should diff against, or null to fall back to a full scan.
 *
 * origin/<base> is not guaranteed to be a local remote-tracking ref even at fetch-depth 0, so the
 * base ref is fetched first and the event's base sha is the fallback. Either candidate can still
 * name an object a shallow checkout never fetched, so the result is verified to resolve before it
 * is used — handing opengrep an unknown sha fails the scan instead of degrading to a full one.
 */
export async function resolveBaseline(context: BaselineContext): Promise<string | null> {
  let baseline = ''

  if (context.baseRef) {
    await git(['fetch', '-q', '--no-tags', 'origin', context.baseRef])
    const mergeBase = await git(['merge-base', 'FETCH_HEAD', 'HEAD'])
    if (mergeBase.code === 0) baseline = mergeBase.stdout
  }

  if (!baseline && context.baseSha) {
    const mergeBase = await git(['merge-base', context.baseSha, 'HEAD'])
    baseline = mergeBase.code === 0 ? mergeBase.stdout : context.baseSha
  }

  if (!baseline) {
    core.warning('Could not resolve a baseline commit; falling back to a full scan.')
    return null
  }

  const present = await git(['cat-file', '-e', `${baseline}^{commit}`])
  if (present.code !== 0) {
    core.warning(`Baseline ${baseline} is not present locally (shallow checkout?); falling back to a full scan.`)
    return null
  }

  return baseline
}
