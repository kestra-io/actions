import * as core from '@actions/core'

/**
 * Rules come from the Semgrep registry at scan time (`--config p/<pack>`), not a vendored checkout.
 *
 * The obvious-looking alternative, opengrep/opengrep-rules, is a dead end: it is archived, its only
 * branch has had no commit since 2025-01-26, and upstream semgrep-rules has moved 185 commits past
 * that snapshot. OpenGrep forked the engine, not the rules — its own documentation points at `p/`
 * packs, and the CLI resolves them from https://semgrep.dev.
 *
 * The trade: rules are always current, and in exchange a scan depends on semgrep.dev being
 * reachable and its content can change between runs. Registry failures are therefore treated as
 * infrastructure problems that skip the scan, never as findings that fail a build.
 */
export const REGISTRY_HOST = 'semgrep.dev'

const ASSET_BY_ARCH: Record<string, string> = {
  X64: 'opengrep_manylinux_x86',
  ARM64: 'opengrep_manylinux_aarch64'
}

export function assetNameFor(arch: string): string {
  const name = ASSET_BY_ARCH[arch]
  if (!name) {
    throw new Error(`Unsupported runner architecture '${arch}' for OpenGrep. Supported: ${Object.keys(ASSET_BY_ARCH).join(', ')}`)
  }
  return name
}

export interface Release {
  /** Concrete tag, e.g. "v1.30.0" — never "latest". */
  readonly tag: string
  readonly version: string
  readonly assetUrl: string
  /** sha256 as reported by the releases API, or null when GitHub did not supply one. */
  readonly sha256: string | null
}

interface ApiAsset {
  name: string
  browser_download_url: string
  digest?: string | null
}

interface ApiRelease {
  tag_name: string
  assets: ApiAsset[]
}

export function releaseApiUrl(version: string): string {
  return version === 'latest'
    ? 'https://api.github.com/repos/opengrep/opengrep/releases/latest'
    : `https://api.github.com/repos/opengrep/opengrep/releases/tags/${version.startsWith('v') ? version : `v${version}`}`
}

/** Pick the asset for this architecture out of a releases API payload. */
export function selectAsset(release: ApiRelease, arch: string): Release {
  const assetName = assetNameFor(arch)
  const asset = release.assets?.find(candidate => candidate.name === assetName)
  if (!asset) {
    throw new Error(`OpenGrep release ${release.tag_name} has no asset named '${assetName}'.`)
  }

  const digest = asset.digest ?? null
  return {
    tag: release.tag_name,
    version: release.tag_name.replace(/^v/, ''),
    assetUrl: asset.browser_download_url,
    sha256: digest?.startsWith('sha256:') ? digest.slice('sha256:'.length) : null
  }
}

/**
 * Resolve an `opengrep-version` input to a concrete release.
 *
 * Note what integrity this can and cannot give you. The checksum is read from the releases API and
 * the binary from the release itself — both from GitHub over TLS — so verifying one against the
 * other catches a truncated or corrupted download, not a compromised release. A pinned version with
 * a checksum committed here would be stronger; `latest` cannot have one by definition. That is the
 * trade `latest` makes, alongside every runner picking up a new engine the day it ships.
 */
export async function resolveRelease(version: string, arch: string, token?: string): Promise<Release> {
  const url = releaseApiUrl(version)
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'kestra-io/actions scan-opengrep'
  }
  if (token) headers.authorization = `Bearer ${token}`

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`Could not resolve OpenGrep release '${version}' (${url} returned HTTP ${response.status}).`)
  }

  const release = selectAsset((await response.json()) as ApiRelease, arch)
  if (!release.sha256) {
    core.warning(`The OpenGrep releases API reported no checksum for ${release.tag}; the download cannot be verified.`)
  }
  return release
}
