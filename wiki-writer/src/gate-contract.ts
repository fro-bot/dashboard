// package.json pins this package to a main-ancestor commit. The upstream
// `Check Wiki Write Core Dist` status check tree-compares committed `dist/`
// with a fresh build, so the compiled Node 24 import is the verified artifact.
import {GATE_CONTRACT_VERSION} from '@fro-bot/wiki-write-core'

export const GATE_CONTRACT_HEAD_URL = 'https://api.github.com/repos/fro-bot/.github/git/ref/heads/main'
export const GATE_CONTRACT_MARKER_URL = 'https://raw.githubusercontent.com/fro-bot/.github/main/packages/wiki-write-core/dist/gate-contract.json'

export const GATE_CONTRACT_CACHE_TTL_MS = 5 * 60 * 1000
export const GATE_CONTRACT_STALE_CEILING_MS = 60 * 60 * 1000

export interface GateContractMarker {
  readonly version: number
  readonly sourceTreeHash: string
}

export interface GateContractReadiness {
  readonly ready: boolean
  readonly stale: boolean
  readonly mainHeadSha?: string
  readonly cacheAgeMs?: number
}

export type GateContractFailure = 'invalid_marker' | 'unavailable' | 'version_mismatch'

export type GateContractDecision =
  | {
    readonly proceed: true
    readonly marker: GateContractMarker
    readonly readiness: GateContractReadiness
  }
  | {
    readonly proceed: false
    readonly reason: GateContractFailure
    readonly readiness: GateContractReadiness
    readonly marker?: GateContractMarker
  }

export interface GateContractLogger {
  readonly warning: (message: string, context?: Record<string, unknown>) => void
}

export interface GateContractCheckerOptions {
  /** Explicit transport seam; production uses public GitHub endpoints without credentials. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly now?: () => number
  readonly logger?: GateContractLogger
}

interface GateContractCacheEntry {
  readonly mainHeadSha: string
  readonly marker: GateContractMarker
  readonly fetchedAt: number
}

interface MainRefResponse {
  readonly object?: {
    readonly sha?: unknown
  }
}

/**
 * Check that the running writer's gates match the control-plane contract.
 *
 * `sourceTreeHash` is diagnostic only. It changes for unrelated source edits,
 * while `version` is the intentional consumer-visible compatibility boundary.
 */
export function createGateContractChecker(options: GateContractCheckerOptions) {
  const cache = new Map<string, GateContractCacheEntry>()
  let latestCacheKey: string | undefined
  const now = options.now ?? (() => Date.now())

  async function check(): Promise<GateContractDecision> {
    const checkedAt = now()
    const latest = latestCacheKey === undefined ? undefined : cache.get(latestCacheKey)
    if (latest !== undefined && checkedAt - latest.fetchedAt < GATE_CONTRACT_CACHE_TTL_MS) {
      return evaluateMarker(latest.marker, readinessFor(latest, checkedAt, false))
    }

    try {
      const mainHeadSha = await fetchMainHeadSha()
      const marker = await fetchMarker()
      const entry: GateContractCacheEntry = {mainHeadSha, marker, fetchedAt: checkedAt}
      cache.set(mainHeadSha, entry)
      latestCacheKey = mainHeadSha
      return evaluateMarker(marker, readinessFor(entry, checkedAt, false))
    } catch (error) {
      if (error instanceof InvalidMarkerError) {
        return {
          proceed: false,
          reason: 'invalid_marker',
          readiness: {ready: false, stale: false},
        }
      }

      if (latest !== undefined) {
        const cacheAgeMs = checkedAt - latest.fetchedAt
        if (cacheAgeMs <= GATE_CONTRACT_STALE_CEILING_MS) {
          options.logger?.warning('gate-contract: using bounded stale cache after fetch failure', {
            cacheAgeMs,
            mainHeadSha: latest.mainHeadSha,
          })
          return evaluateMarker(latest.marker, readinessFor(latest, checkedAt, true))
        }
      }

      const staleCacheMetadata = latest === undefined
        ? {}
        : {
            mainHeadSha: latest.mainHeadSha,
            cacheAgeMs: checkedAt - latest.fetchedAt,
          }
      return {
        proceed: false,
        reason: 'unavailable',
        readiness: {
          ready: false,
          stale: true,
          ...staleCacheMetadata,
        },
      }
    }
  }

  async function fetchMainHeadSha(): Promise<string> {
    const response = await options.fetch(GATE_CONTRACT_HEAD_URL, {
      headers: {accept: 'application/vnd.github+json'},
    })
    if (!response.ok) throw new Error('Gate contract head fetch failed')

    let body: unknown
    try {
      body = JSON.parse(await response.text()) as unknown
    } catch {
      throw new Error('Gate contract head response was not JSON')
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Gate contract head response was invalid')
    const sha = (body as MainRefResponse).object?.sha
    if (typeof sha !== 'string' || sha.length === 0) throw new Error('Gate contract head response was invalid')
    return sha
  }

  async function fetchMarker(): Promise<GateContractMarker> {
    const response = await options.fetch(GATE_CONTRACT_MARKER_URL, {
      headers: {accept: 'application/json'},
    })
    if (!response.ok) throw new Error('Gate contract marker fetch failed')

    let body: unknown
    try {
      body = JSON.parse(await response.text()) as unknown
    } catch {
      throw new InvalidMarkerError()
    }

    if (!isGateContractMarker(body)) throw new InvalidMarkerError()
    return body
  }

  return {check}
}

function isGateContractMarker(value: unknown): value is GateContractMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.version === 'number' &&
    Number.isInteger(candidate.version) &&
    typeof candidate.sourceTreeHash === 'string' &&
    candidate.sourceTreeHash.length > 0
  )
}

function evaluateMarker(marker: GateContractMarker, readiness: GateContractReadiness): GateContractDecision {
  if (marker.version !== GATE_CONTRACT_VERSION) {
    return {proceed: false, reason: 'version_mismatch', marker, readiness: {...readiness, ready: false}}
  }
  return {proceed: true, marker, readiness: {...readiness, ready: true}}
}

function readinessFor(entry: GateContractCacheEntry, checkedAt: number, stale: boolean): GateContractReadiness {
  return {
    ready: !stale,
    stale,
    mainHeadSha: entry.mainHeadSha,
    cacheAgeMs: checkedAt - entry.fetchedAt,
  }
}

class InvalidMarkerError extends Error {
  constructor() {
    super('Gate contract marker was invalid')
  }
}
