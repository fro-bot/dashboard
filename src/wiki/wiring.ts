/**
 * Wiki wiring: composes the read side, the write side and the identity policy.
 *
 * This is the only production module that builds the Fro Bot write-token client.
 * List and page reads use a read token source from the existing read mint. The
 * save path, the dispatch port and promotion status use a write token source
 * built from the Fro Bot App client. The fixture target never passes through here.
 */

import type {WriteTokenProvider} from '../github/fro-bot-app-client.ts'
import type {WikiAppDeps} from '../routes/wiki.ts'
import type {WikiWriteConfig} from './config.ts'
import type {ReadTokenSource} from './data-client.ts'

import {createDashboardAppClient} from '../github/app-client.ts'
import {createFroBotAppClient} from '../github/fro-bot-app-client.ts'
import {mintReadOnlyToken} from '../github/installations.ts'
import {logger} from '../logger.ts'
import {
  createBlobCache,
  createReadTransport,
  createWikiDataClient,
  createWriteTransport,
  readTokenSource,
  writeTokenSource,
} from './data-client.ts'
import {createGateContractChecker} from './gate-contract.ts'
import {createWikiPages} from './pages.ts'
import {createDispatchPort, createPromotionStatusReader} from './promotion.ts'
import {createWikiWriteOperation} from './write-operation.ts'

/** Wiki write capability after wiring: either a token provider, or off with a reason. */
export type WikiWriteWiring =
  | {readonly enabled: true; readonly config: Extract<WikiWriteConfig, {enabled: true}>; readonly tokens: WriteTokenProvider}
  | Extract<WikiWriteConfig, {enabled: false}>

/**
 * Build the write-token client only when the configuration enables writes.
 * A half-configured credential pair leaves writes off and logs a warning.
 */
export function buildWikiWriteWiring(config: WikiWriteConfig): WikiWriteWiring {
  if (!config.enabled) {
    if (config.reason === 'app-credentials-incomplete') {
      logger.warning(
        'Only one of DASHBOARD_FRO_BOT_APP_ID and DASHBOARD_FRO_BOT_APP_KEY is set — wiki write capability disabled',
      )
    }
    return config
  }
  return {
    enabled: true,
    config,
    tokens: createFroBotAppClient({appId: config.appId, privateKey: config.privateKey}),
  }
}

const WIKI_INSTALLATION_TTL_MS = 10 * 60_000

/**
 * Read-token source for the wiki repository, from the existing read mint. The
 * installation ID is resolved with the App JWT and trusted for a bounded time;
 * tokens come from `mintReadOnlyToken`, which caches them.
 */
export function createWikiReadTokenSource(deps: {
  readonly resolveInstallationId: () => Promise<unknown>
  readonly mint: (installationId: number, permissions: Record<string, 'read'>) => Promise<string>
  readonly now?: () => number
}): ReadTokenSource {
  const now = deps.now ?? Date.now
  let resolved: {readonly id: number; readonly at: number} | null = null

  return readTokenSource(async () => {
    if (resolved === null || now() - resolved.at >= WIKI_INSTALLATION_TTL_MS) {
      const id: unknown = await deps.resolveInstallationId()
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
        throw new Error('Installation lookup returned an unexpected response')
      }
      resolved = {id, at: now()}
    }
    return mintReadOnlyToken(resolved.id, deps.mint)
  })
}

export function buildWikiReadTokens(credentials: {appId: string; privateKey: string}): ReadTokenSource {
  const appClient = createDashboardAppClient(credentials)
  return createWikiReadTokenSource({
    mint: appClient.mintInstallationToken,
    resolveInstallationId: async () => {
      const response = await appClient.octokit.request('GET /repos/{owner}/{repo}/installation', {
        owner: 'fro-bot',
        repo: '.github',
      })
      const data: unknown = response.data
      return typeof data === 'object' && data !== null ? (data as {id?: unknown}).id : undefined
    },
  })
}

/**
 * Compose the wiki capability. List and page reads use the read token source.
 * The save path, the dispatch port, and promotion status use the write token
 * source built from the Fro Bot App client. With no read credentials the pages
 * are unavailable; with write capability off there is no write side at all.
 */
export function buildWikiAppDeps(input: {
  readonly readTokens: ReadTokenSource | null
  readonly write: WikiWriteWiring
  readonly fetch?: typeof fetch | undefined
}): WikiAppDeps {
  const transportOptions = input.fetch === undefined ? {} : {fetch: input.fetch}
  const blobCache = createBlobCache()
  const {check: checkContract} = createGateContractChecker({
    fetch: async (url, init) => fetch(url, init),
    logger,
  })

  const pages =
    input.readTokens === null
      ? null
      : createWikiPages({
          client: createWikiDataClient(createReadTransport(input.readTokens, transportOptions), {blobCache}),
          checkContract,
        })

  if (!input.write.enabled) {
    return {
      pages,
      write: null,
      policy: {capability: {enabled: false, reason: input.write.reason}, fixtureOperatorLogin: null},
    }
  }

  const {tokens, config} = input.write
  const client = createWikiDataClient(
    createWriteTransport(
      writeTokenSource(
        async () => tokens.getWriteToken(),
        token => {
          tokens.invalidate(token)
        },
      ),
      transportOptions,
    ),
    {blobCache},
  )
  const dispatch = createDispatchPort({client})
  return {
    pages,
    write: {
      operation: createWikiWriteOperation({client, checkContract, dispatch}),
      dispatch,
      status: createPromotionStatusReader({client}),
    },
    policy: {
      capability: {enabled: true, operatorId: config.operatorId, dashboardOrigin: config.dashboardOrigin},
      fixtureOperatorLogin: null,
    },
  }
}
