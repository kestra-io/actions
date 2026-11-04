export const FALLBACK_REF = 'develop'
export const MAX_HOPS = 20

export interface Lookups {
  ossHas(ref: string): Promise<boolean>
  openPrBase(head: string): Promise<string | undefined>
}

export interface Resolution {
  ref: string
  sameName: boolean
  walk: string[]
}

export async function resolveOssRef(head: string, base: string | undefined, lookups: Lookups): Promise<Resolution> {
  const walk: string[] = []
  let current: string | undefined = head
  while (current !== undefined && walk.length < MAX_HOPS && !walk.includes(current)) {
    walk.push(current)
    if (await lookups.ossHas(current)) {
      return { ref: current, sameName: current === head, walk }
    }
    current = walk.length === 1 ? base : await lookups.openPrBase(current)
  }
  return { ref: FALLBACK_REF, sameName: false, walk }
}

export function gitRefPath(ref: string): string {
  return ref.startsWith('refs/') ? ref.slice('refs/'.length) : `heads/${ref}`
}
