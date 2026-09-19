import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveRelease, type Release } from './version.js'

export async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export const binaryCacheDir = (version: string): string => path.join(os.homedir(), '.cache', 'opengrep', version)

export interface Installed {
  readonly binary: string
  readonly release: Release
}

/**
 * Cache keys use the resolved tag, never the requested version: `latest` moves, and a key built
 * from the literal string "latest" would serve yesterday's binary forever. Exact-match with no
 * restoreKeys, so a new release misses and re-downloads rather than reusing an older build.
 */
export async function installOpengrep(version: string, arch: string, token?: string): Promise<Installed> {
  const release = await resolveRelease(version, arch, token)
  if (version === 'latest') core.info(`OpenGrep 'latest' resolved to ${release.tag}.`)

  const dir = binaryCacheDir(release.version)
  const binary = path.join(dir, 'opengrep')
  const key = `opengrep-${process.platform}-${arch}-${release.version}`

  if ((await restoreCache([dir], key)) && (await exists(binary))) {
    core.info(`OpenGrep ${release.version} restored from cache.`)
    return { binary, release }
  }

  core.info(`Downloading OpenGrep ${release.version}…`)
  await fs.mkdir(dir, { recursive: true })
  const downloaded = await tc.downloadTool(release.assetUrl)

  if (release.sha256) {
    const actual = await sha256(downloaded)
    if (actual !== release.sha256) {
      throw new Error(`OpenGrep ${release.tag} checksum mismatch: expected ${release.sha256}, got ${actual}. Refusing to run.`)
    }
  }

  await fs.copyFile(downloaded, binary)
  await fs.chmod(binary, 0o755)
  await saveCache([dir], key)
  return { binary, release }
}

/**
 * The cache is an optimisation, never a correctness input: a miss re-downloads a checksum-verified
 * binary. So every cache failure degrades instead of failing the scan — a save races with other
 * jobs writing the same key and the loser gets "already exists", and both calls throw outright
 * where no cache service is configured (act, a self-hosted runner without it).
 */
async function restoreCache(paths: string[], key: string): Promise<boolean> {
  try {
    return (await cache.restoreCache(paths, key)) != null
  } catch (error) {
    core.warning(`Could not restore cache '${key}': ${(error as Error).message}`)
    return false
  }
}

async function saveCache(paths: string[], key: string): Promise<void> {
  try {
    await cache.saveCache(paths, key)
  } catch (error) {
    core.warning(`Could not save cache '${key}': ${(error as Error).message}`)
  }
}
