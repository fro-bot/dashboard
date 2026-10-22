/**
 * Fixture write target for the wiki routes.
 *
 * An in-memory `fro-bot/.github` `data` branch behind the real `/api/wiki/*`
 * routes. The Git Data transport is the only fake: the page models, the write
 * operation, the shared gates, the dispatch port, and the promotion reader are the
 * production modules. It needs no GitHub credential and makes no network request.
 *
 * Fault pages are ordinary entries in the page list. Each fault is keyed on the
 * page ID the client already sends. It fires on the first save, lets the saves
 * that follow through, and arms again after the next save that succeeds. The
 * server imports this module only while the fixture harness is active.
 *
 * The in-memory repository (`FixtureRepo`) is also the model the write-path tests
 * run against.
 */

import type {CorrectionRecord} from '@fro.bot/wiki-write-core'
import type {WikiAppDeps} from '../routes/wiki.ts'
import type {GitHubDataTransport} from './data-client.ts'
import type {GateContractDecision} from './gate-contract.ts'
import type {WikiPages} from './pages.ts'
import type {WikiWriteOperation} from './write-operation.ts'

import {AsyncLocalStorage} from 'node:async_hooks'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {
  GATE_CONTRACT_VERSION,
  parseCorrections,
  rebuildWikiIndex,
  serializeCorrections,
} from '@fro.bot/wiki-write-core'
import {createBlobCache, createWikiDataClient} from './data-client.ts'
import {isRecord} from './guards.ts'
import {createWikiPages} from './pages.ts'
import {CORRECTIONS_PATH, parseWikiPagePath, resolvePagePath, WIKI_INDEX_PATH, WIKI_LOG_PATH} from './paths.ts'
import {createDispatchPort, createPromotionStatusReader} from './promotion.ts'
import {createWikiWriteOperation} from './write-operation.ts'

type Params = Record<string, unknown>

// ---------------------------------------------------------------------------
// In-memory Git Data repository
// ---------------------------------------------------------------------------

export interface FixtureCommit {
  readonly sha: string
  readonly message: string
  readonly parents: readonly string[]
  readonly treeSha: string
  readonly committedAt: string
  readonly author: unknown
  readonly committer: unknown
  readonly touched: ReadonlySet<string>
}

export interface FixtureRepoOptions {
  readonly files: Record<string, string>
  /** Clock start for a manually advanced clock. Ignored when `now` is given. */
  readonly startMs?: number
  /** Follow this clock instead of a manual one. Commit times stay strictly increasing. */
  readonly now?: () => number
}

export interface FixtureRepoHooks {
  /** Runs before the ref update is evaluated. May move the head or throw. */
  beforeUpdateRef?: (attempt: number) => void
  /** Runs after a ref update lands. May throw to lose the response. */
  afterUpdateRef?: (attempt: number) => void
  /** Runs before each transport method. May throw. */
  onCall?: (method: string, params: Params) => void
}

/** Where the promotion pull requests, workflow runs, and jobs come from. */
export interface FixturePromotionProvider {
  readonly pulls: () => unknown[]
  readonly runs: (params: Params) => unknown[]
  readonly jobs: (runId: number) => unknown[]
  /** Called when a dispatch is accepted. */
  readonly onDispatch: () => void
}

/** An error shaped like an Octokit request error: a status and response headers. */
export class FixtureHttpError extends Error {
  readonly status: number | undefined
  readonly response: {readonly headers: Record<string, string>} | undefined

  constructor(message: string, status?: number, headers?: Record<string, string>) {
    super(message)
    this.name = 'FixtureHttpError'
    this.status = status
    this.response = headers === undefined ? undefined : {headers}
  }
}

export function blobShaOf(content: string): string {
  return `blob-${createHash('sha1').update(content).digest('hex').slice(0, 12)}`
}

export class FixtureRepo {
  readonly commits = new Map<string, FixtureCommit>()
  readonly trees = new Map<string, Record<string, string>>()
  readonly blobs = new Map<string, string>()
  readonly calls: {method: string; params: Params}[] = []
  readonly hooks: FixtureRepoHooks = {}
  promotion: FixturePromotionProvider | null = null
  head: string
  clockMs: number
  private readonly clock: (() => number) | undefined
  private treeCount = 0
  private commitCount = 0
  private updateAttempts = 0

  constructor(options: FixtureRepoOptions) {
    this.clock = options.now
    this.clockMs = options.startMs ?? (options.now === undefined ? Date.parse('2030-01-01T00:00:00Z') : options.now())
    const treeSha = this.storeTree(
      Object.fromEntries(Object.entries(options.files).map(([path, content]) => [path, this.storeBlob(content)])),
    )
    this.head = this.storeCommit({message: 'initial', parents: [], treeSha, touched: new Set(Object.keys(options.files))})
  }

  /** Files at the current head. */
  files(): Record<string, string> {
    const tree = this.trees.get(this.commit(this.head).treeSha) ?? {}
    return Object.fromEntries(Object.entries(tree).map(([path, sha]) => [path, this.blobs.get(sha) ?? '']))
  }

  blobShaAt(path: string): string | undefined {
    return (this.trees.get(this.commit(this.head).treeSha) ?? {})[path]
  }

  commit(sha: string): FixtureCommit {
    const commit = this.commits.get(sha)
    if (commit === undefined) throw new FixtureHttpError('Not Found', 404)
    return commit
  }

  count(method: string): number {
    return this.calls.filter(call => call.method === method).length
  }

  advance(ms: number): void {
    this.clockMs += ms
  }

  /** A pipeline commit: applies changes and removals on top of the head and moves it. */
  pipelineCommit(changes: Record<string, string>, message = 'chore(pipeline): update', removals: readonly string[] = []): string {
    const base = {...(this.trees.get(this.commit(this.head).treeSha) ?? {})}
    for (const [path, content] of Object.entries(changes)) base[path] = this.storeBlob(content)
    for (const path of removals) delete base[path]
    const treeSha = this.storeTree(base)
    this.nextCommitTime()
    this.head = this.storeCommit({
      message,
      parents: [this.head],
      treeSha,
      touched: new Set([...Object.keys(changes), ...removals]),
    })
    return this.head
  }

  /** A pipeline commit that removes a file. */
  removeFile(path: string, message = 'chore(pipeline): remove'): string {
    return this.pipelineCommit({}, message, [path])
  }

  /** Commits reachable from the head, newest first. */
  history(): FixtureCommit[] {
    const chain: FixtureCommit[] = []
    let sha: string | undefined = this.head
    while (sha !== undefined) {
      const commit: FixtureCommit = this.commit(sha)
      chain.push(commit)
      sha = commit.parents[0]
    }
    return chain
  }

  /** Commits that carry a given trailer line. */
  commitsWithTrailer(operationId: string): FixtureCommit[] {
    return [...this.commits.values()].filter(commit => commit.message.includes(`Fro-Operation-Id: ${operationId}`))
  }

  transport(): Required<GitHubDataTransport> {
    const call = async (method: string, params: Params, run: () => unknown, recorded = false): Promise<{data: unknown}> => {
      if (!recorded) this.calls.push({method, params})
      this.hooks.onCall?.(method, params)
      return {data: run()}
    }
    return {
      getRef: async params => call('getRef', params, () => ({object: {sha: this.head}})),
      getCommit: async params =>
        call('getCommit', params, () => {
          const commit = this.commit(String(params.commit_sha))
          return {sha: commit.sha, message: commit.message, parents: commit.parents.map(sha => ({sha})), tree: {sha: commit.treeSha}}
        }),
      getTree: async params =>
        call('getTree', params, () => {
          const tree = this.trees.get(String(params.tree_sha))
          if (tree === undefined) throw new FixtureHttpError('Not Found', 404)
          return {truncated: false, tree: Object.entries(tree).map(([path, sha]) => ({path, type: 'blob', sha}))}
        }),
      getBlob: async params =>
        call('getBlob', params, () => {
          const content = this.blobs.get(String(params.file_sha))
          if (content === undefined) throw new FixtureHttpError('Not Found', 404)
          return {content: Buffer.from(content).toString('base64'), encoding: 'base64'}
        }),
      createBlob: async params => call('createBlob', params, () => ({sha: this.storeBlob(String(params.content))})),
      createTree: async params =>
        call('createTree', params, () => {
          const base = {...(this.trees.get(String(params.base_tree)) ?? {})}
          for (const entry of params.tree as {path: string; sha: string}[]) base[entry.path] = entry.sha
          return {sha: this.storeTree(base)}
        }),
      createCommit: async params =>
        call('createCommit', params, () => {
          const parents = params.parents as string[]
          const parentTree = this.trees.get(this.commit(parents[0] ?? '').treeSha) ?? {}
          const nextTree = this.trees.get(String(params.tree)) ?? {}
          const touched = new Set(
            Object.keys({...parentTree, ...nextTree}).filter(path => parentTree[path] !== nextTree[path]),
          )
          this.nextCommitTime()
          const sha = this.storeCommit({
            message: String(params.message),
            parents,
            treeSha: String(params.tree),
            touched,
            author: params.author,
            committer: params.committer,
          })
          return {sha, committer: {date: this.commit(sha).committedAt}}
        }),
      updateRef: async params => {
        // Recorded before the hook runs, so an attempt the hook refuses still counts.
        this.calls.push({method: 'updateRef', params})
        this.updateAttempts += 1
        const attempt = this.updateAttempts
        this.hooks.beforeUpdateRef?.(attempt)
        return call('updateRef', params, () => {
          const commit = this.commit(String(params.sha))
          if (params.force === true) throw new Error('forced ref updates are not allowed')
          if (commit.parents[0] !== this.head) throw new FixtureHttpError('Update is not a fast forward', 422)
          this.head = commit.sha
          this.hooks.afterUpdateRef?.(attempt)
          return {}
        }, true)
      },
      listCommitsByPath: async params =>
        call('listCommitsByPath', params, () => {
          const since = typeof params.since === 'string' ? Date.parse(params.since) : Number.NEGATIVE_INFINITY
          const limit = Number(params.per_page ?? 30)
          const found: unknown[] = []
          let sha: string | undefined = this.head
          while (sha !== undefined && found.length < limit) {
            const commit: FixtureCommit = this.commit(sha)
            if (Date.parse(commit.committedAt) < since) break
            if (commit.touched.has(String(params.path))) {
              found.push({
                sha: commit.sha,
                commit: {message: commit.message, tree: {sha: commit.treeSha}, committer: {date: commit.committedAt}},
                parents: commit.parents.map(parent => ({sha: parent})),
              })
            }
            sha = commit.parents[0]
          }
          return found
        }),
      createDispatch: async params =>
        call('createDispatch', params, () => {
          this.promotion?.onDispatch()
          return {}
        }),
      listPulls: async params => call('listPulls', params, () => this.promotion?.pulls() ?? []),
      listWorkflowRuns: async params =>
        call('listWorkflowRuns', params, () => ({workflow_runs: this.promotion?.runs(params) ?? []})),
      listRunJobs: async params => call('listRunJobs', params, () => ({jobs: this.promotion?.jobs(Number(params.run_id)) ?? []})),
    }
  }

  /** Advance to the time of the next commit: a step on a manual clock, or the clock itself. */
  private nextCommitTime(): void {
    this.clockMs = this.clock === undefined ? this.clockMs + 1000 : Math.max(this.clock(), this.clockMs + 1)
  }

  private storeBlob(content: string): string {
    const sha = blobShaOf(content)
    this.blobs.set(sha, content)
    return sha
  }

  private storeTree(tree: Record<string, string>): string {
    this.treeCount += 1
    const sha = `tree-${this.treeCount}`
    this.trees.set(sha, tree)
    return sha
  }

  private storeCommit(input: {
    message: string
    parents: readonly string[]
    treeSha: string
    touched: ReadonlySet<string>
    author?: unknown
    committer?: unknown
  }): string {
    this.commitCount += 1
    const sha = `commit-${this.commitCount}`
    this.commits.set(sha, {
      sha,
      message: input.message,
      parents: input.parents,
      treeSha: input.treeSha,
      committedAt: new Date(this.clockMs).toISOString(),
      author: input.author,
      committer: input.committer,
      touched: input.touched,
    })
    return sha
  }
}

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

/** Fault pages by name. Each ID is an ordinary `<dir>.<name>` page ID in the list. */
export const FIXTURE_PAGE_IDS = {
  plain: 'repos.fixture--plain',
  correctionsConflict: 'repos.fixture--corrections-conflict',
  noNodeId: 'topics.fixture-no-node-id',
  conflict: 'topics.fixture-conflict',
  pageConflict: 'repos.fixture--page-conflict',
  timeoutLanded: 'topics.fixture-timeout-landed',
  timeoutLost: 'topics.fixture-timeout-lost',
  dispatchFailure: 'topics.fixture-dispatch-failure',
  blocked: 'topics.fixture-blocked',
  contractMismatch: 'topics.fixture-contract-mismatch',
  contractUnreadable: 'topics.fixture-contract-unreadable',
  rateLimit: 'topics.fixture-rate-limit',
  failed: 'topics.fixture-failed',
  rejected: 'topics.fixture-rejected',
  vanishes: 'entities.fixture-vanishes',
  comparison: 'comparisons.fixture-a-vs-b',
} as const

const IDS = FIXTURE_PAGE_IDS
const FAULT_PAGE_IDS: ReadonlySet<string> = new Set(Object.values(IDS))

/** How long a simulated promotion run stays in progress. */
export const FIXTURE_RUN_DURATION_MS = 20_000

const PR_NUMBER = 4100
const FIRST_DISPATCH_RUN_ID = 5000
const BASELINE_RUN_ID = 4999
const RATE_LIMIT_RETRY_SECONDS = 20
const BLOCKING_STEP = '\uD83D\uDD12 Block private wiki pages'
const REPOSITORY_URL = 'https://github.com/fro-bot/.github'

interface SeedPage {
  readonly id: string
  readonly type: 'repo' | 'topic' | 'entity' | 'comparison'
  readonly title: string
  readonly nodeId?: string
  readonly body: string
}

function pathOfId(id: string): string {
  const [directory, ...name] = id.split('.')
  return `knowledge/wiki/${directory ?? ''}/${name.join('.')}.md`
}

function pageText(page: SeedPage): string {
  const values: Record<string, string> = {
    type: page.type,
    title: page.title,
    created: '2026-01-01',
    updated: '2026-02-01',
    ...(page.nodeId === undefined ? {} : {node_id: page.nodeId}),
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${page.body}`
}

const PLAIN_SPAN = 'The fixture builds widgets for demonstration.'
const CONFLICT_SPAN = 'The first marked sentence stays put.'
const UPSTREAM_SPAN = 'The second sentence is marked by the other writer.'
const CONFLICT_NODE_ID = 'R_fixture_corrections_conflict'
const PLAIN_NODE_ID = 'R_fixture_plain'
const PAGE_CONFLICT_NODE_ID = 'R_fixture_page_conflict'

// The page-conflict page: the other writer inserts a line above the paragraphs and
// changes one line in the middle, so a mark in an untouched paragraph merges cleanly
// and an edit to the middle line overlaps.
const PAGE_CONFLICT_HEADING = '# fixture/page-conflict'
const PAGE_CONFLICT_INSERTED = 'Another writer added this line above the paragraphs.'
const PAGE_CONFLICT_MIDDLE_BASE = 'The middle paragraph says the widgets ship weekly.'
const PAGE_CONFLICT_MIDDLE_UPSTREAM = 'The middle paragraph says the widgets ship daily.'

const SEED_PAGES: readonly SeedPage[] = [
  {
    id: IDS.plain,
    type: 'repo',
    title: 'fixture/plain',
    nodeId: PLAIN_NODE_ID,
    body: `\n# fixture/plain\n\nA plain page. Save an edit: the save commits to the data branch, dispatches the promotion, and joins the open pull request.\n\n${PLAIN_SPAN}\n`,
  },
  {
    id: IDS.correctionsConflict,
    type: 'repo',
    title: 'fixture/corrections-conflict',
    nodeId: CONFLICT_NODE_ID,
    body: `\n# fixture/corrections-conflict\n\nSave a correction change on this page and another writer will already have changed its corrections.\n\n${CONFLICT_SPAN}\n\n${UPSTREAM_SPAN}\n`,
  },
  {
    id: IDS.pageConflict,
    type: 'repo',
    title: 'fixture/page-conflict',
    nodeId: PAGE_CONFLICT_NODE_ID,
    body: `\n${PAGE_CONFLICT_HEADING}\n\nSave an edit on this page and another writer will already have changed it.\n\nThe first paragraph stays as it is.\n\n${PAGE_CONFLICT_MIDDLE_BASE}\n\nThe last paragraph stays as it is.\n`,
  },
  {
    id: IDS.noNodeId,
    type: 'topic',
    title: 'Fixture - page without node id',
    body: '\n# Fixture - page without node id\n\nThis page has no node id, so it takes edits but no marks. Its edits do not survive regeneration.\n',
  },
  {
    id: IDS.conflict,
    type: 'topic',
    title: 'Fixture - conflict on first save',
    body: '\n# Fixture - conflict on first save\n\nAnother writer changes this page after it opens. The first save reports a newer version; reload and save again.\n',
  },
  {
    id: IDS.timeoutLanded,
    type: 'topic',
    title: 'Fixture - timeout, commit landed',
    body: '\n# Fixture - timeout, commit landed\n\nThe first save times out after the commit landed. Check the save status and it reports the save as done.\n',
  },
  {
    id: IDS.timeoutLost,
    type: 'topic',
    title: 'Fixture - timeout, commit lost',
    body: '\n# Fixture - timeout, commit lost\n\nThe first save times out before the commit landed. Check the save status and it reports the save as missing; save again.\n',
  },
  {
    id: IDS.dispatchFailure,
    type: 'topic',
    title: 'Fixture - dispatch failure',
    body: '\n# Fixture - dispatch failure\n\nThe first save commits but the promotion dispatch fails. Retry the dispatch and it succeeds without a second commit.\n',
  },
  {
    id: IDS.blocked,
    type: 'topic',
    title: 'Fixture - blocked promotion',
    body: '\n# Fixture - blocked promotion\n\nSaving this page promotes a change that the privacy check blocks. The promotion run fails at the step that blocks private wiki pages.\n',
  },
  {
    id: IDS.contractMismatch,
    type: 'topic',
    title: 'Fixture - gate contract mismatch',
    body: '\n# Fixture - gate contract mismatch\n\nThe gate contract differs from the control plane, so saves are refused until the dashboard is deployed.\n',
  },
  {
    id: IDS.contractUnreadable,
    type: 'topic',
    title: 'Fixture - gate contract unreadable',
    body: '\n# Fixture - gate contract unreadable\n\nThe gate contract marker cannot be read. The first save is refused and a retry goes through.\n',
  },
  {
    id: IDS.rateLimit,
    type: 'topic',
    title: 'Fixture - GitHub rate limit',
    body: '\n# Fixture - GitHub rate limit\n\nThe first save hits a GitHub rate limit and reports when to retry. A retry goes through.\n',
  },
  {
    id: IDS.failed,
    type: 'topic',
    title: 'Fixture - write failure',
    body: '\n# Fixture - write failure\n\nThe first save fails before anything is committed. A retry goes through.\n',
  },
  {
    id: IDS.rejected,
    type: 'topic',
    title: 'Fixture - rejected by a gate',
    body: '\n# Fixture - rejected by a gate\n\nThis page holds an inline frame that the rendering policy rejects. Remove the frame line and save.\n\n<iframe src="about:blank"></iframe>\n',
  },
  {
    id: IDS.vanishes,
    type: 'entity',
    title: 'Fixture - page that vanishes',
    body: '\n# Fixture - page that vanishes\n\nThis page is removed after it opens. The first save finds it gone.\n',
  },
  {
    id: IDS.comparison,
    type: 'comparison',
    title: 'Fixture - A versus B',
    body: '\n# Fixture - A versus B\n\nA comparison page. It saves like any other page.\n',
  },
]

function correctionRecord(id: string, nodeId: string, text: string, actor: string): CorrectionRecord {
  return {
    id,
    page_node_id: nodeId,
    span: {text},
    state: 'active',
    attribution: {actor, recorded_at: '2026-02-01T00:00:00Z'},
  }
}

function seedPageFiles(): Record<string, string> {
  return Object.fromEntries(SEED_PAGES.map(page => [pathOfId(page.id), pageText(page)]))
}

function seedFiles(): Record<string, string> {
  const pages = seedPageFiles()
  return {
    ...pages,
    [WIKI_INDEX_PATH]: rebuildWikiIndex({existingIndex: '# Wiki Index\n\nMaster catalog.\n', wikiFiles: pages}),
    [WIKI_LOG_PATH]: '# Wiki Log\n\n---\n',
    [CORRECTIONS_PATH]: serializeCorrections({
      version: 1,
      corrections: [
        correctionRecord('fixture-correction-plain', PLAIN_NODE_ID, PLAIN_SPAN, 'fixture-operator'),
        correctionRecord('fixture-correction-conflict', CONFLICT_NODE_ID, CONFLICT_SPAN, 'fixture-operator'),
      ],
    }),
    'knowledge/wiki/README.md': '# Wiki\n\nFixture wiki. This file has no frontmatter on purpose.\n',
    'metadata/repos.yaml': 'version: 1\nrepos: []\n',
  }
}

// ---------------------------------------------------------------------------
// Simulated promotion
// ---------------------------------------------------------------------------

interface SimulatedRun {
  readonly id: number
  readonly createdMs: number
  readonly endsMs: number
  readonly event: string
  readonly conclusion: 'success' | 'failure'
  cancelled: boolean
}

export interface FixturePromotion {
  readonly provider: FixturePromotionProvider
  readonly runs: readonly SimulatedRun[]
}

/**
 * One open pull request from `data` into `main`, and workflow runs created by each
 * dispatch. A run fails at the privacy step when the changes it promotes touch the
 * blocked page; otherwise it succeeds. A newer dispatch cancels a run in progress.
 */
function createPromotion(repo: FixtureRepo, now: () => number, runDurationMs: number): FixturePromotion {
  const blockedPath = pathOfId(IDS.blocked)
  const startedMs = now()
  const runs: SimulatedRun[] = [
    {
      id: BASELINE_RUN_ID,
      createdMs: startedMs - 3_600_000,
      endsMs: startedMs - 3_540_000,
      event: 'schedule',
      conclusion: 'success',
      cancelled: false,
    },
  ]
  let lastPromotedHead = repo.head
  let nextId = FIRST_DISPATCH_RUN_ID

  function touchedSince(sha: string): Set<string> {
    const touched = new Set<string>()
    for (const commit of repo.history()) {
      if (commit.sha === sha) break
      for (const path of commit.touched) touched.add(path)
    }
    return touched
  }

  function describe(run: SimulatedRun): {status: string; conclusion: string | null} {
    if (run.cancelled) return {status: 'completed', conclusion: 'cancelled'}
    if (now() < run.endsMs) return {status: 'in_progress', conclusion: null}
    return {status: 'completed', conclusion: run.conclusion}
  }

  const provider: FixturePromotionProvider = {
    pulls: () => [
      {
        number: PR_NUMBER,
        html_url: `${REPOSITORY_URL}/pull/${PR_NUMBER}`,
        created_at: new Date(startedMs - 86_400_000).toISOString(),
      },
    ],
    runs: params => {
      const limit = Number(params.per_page ?? 30)
      return [...runs]
        .sort((left, right) => right.createdMs - left.createdMs || right.id - left.id)
        .slice(0, limit)
        .map(run => ({
          id: run.id,
          event: run.event,
          created_at: new Date(run.createdMs).toISOString(),
          html_url: `${REPOSITORY_URL}/actions/runs/${run.id}`,
          ...describe(run),
        }))
    },
    jobs: runId => {
      const run = runs.find(candidate => candidate.id === runId)
      if (run === undefined) return []
      const failed = describe(run).conclusion === 'failure'
      return [
        {
          name: 'Merge data into main',
          conclusion: failed ? 'failure' : 'success',
          steps: [
            {name: 'Set up job', conclusion: 'success'},
            {name: BLOCKING_STEP, conclusion: failed ? 'failure' : 'success'},
            {name: '\uD83D\uDD01 Merge main into data', conclusion: failed ? 'skipped' : 'success'},
          ],
        },
      ]
    },
    onDispatch: () => {
      const blocked = touchedSince(lastPromotedHead).has(blockedPath)
      for (const run of runs) if (!run.cancelled && now() < run.endsMs) run.cancelled = true
      // A run cannot predate the commit it promotes.
      const createdMs = Math.max(now(), repo.clockMs)
      runs.push({
        id: nextId,
        createdMs,
        endsMs: createdMs + runDurationMs,
        event: 'repository_dispatch',
        conclusion: blocked ? 'failure' : 'success',
        cancelled: false,
      })
      nextId += 1
      lastPromotedHead = repo.head
    },
  }
  return {provider, runs}
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

interface FaultScope {
  readonly kind: 'list' | 'read' | 'save' | 'lookup'
  readonly pageId: string | null
  /** Set once the commit of a timed-out save has landed: history reads then fail. */
  listingBlocked: boolean
}

const OK_CONTRACT: GateContractDecision = {
  proceed: true,
  marker: {version: GATE_CONTRACT_VERSION, sourceTreeHash: 'fixture'},
  readiness: {ready: true, stale: false, mainHeadSha: 'fixture-main'},
}

const MISMATCH_CONTRACT: GateContractDecision = {
  proceed: false,
  reason: 'version_mismatch',
  marker: {version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 'fixture'},
  readiness: {ready: false, stale: false, mainHeadSha: null},
}

const UNREADABLE_CONTRACT: GateContractDecision = {
  proceed: false,
  reason: 'unavailable',
  readiness: {ready: false, stale: true, mainHeadSha: null},
}

function wikiPagePaths(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => parseWikiPagePath(path) !== null))
}

function rebuiltIndex(files: Record<string, string>, wikiFiles: Record<string, string>): string {
  return rebuildWikiIndex({existingIndex: files[WIKI_INDEX_PATH] ?? '# Wiki Index\n', wikiFiles})
}

function pageIdOf(input: unknown): string | null {
  return isRecord(input) && typeof input.pageId === 'string' ? input.pageId : null
}

function carriesCorrectionChange(input: unknown): boolean {
  if (!isRecord(input)) return false
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0
  return nonEmpty(input.marks) || nonEmpty(input.transitions)
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface FixtureOptions {
  /** The origin write requests must come from. */
  readonly dashboardOrigin: string
  /** The operator login an Arctic session needs to write, or null for none. */
  readonly operatorLogin: string | null
  /** Replaces the wall clock. Tests only. */
  readonly now?: (() => number) | undefined
  readonly runDurationMs?: number | undefined
}

export interface FixtureWikiTarget {
  readonly deps: WikiAppDeps
  readonly repo: FixtureRepo
  readonly promotion: FixturePromotion
}

/** The loopback origin a server bound to `host:port` is reached at. */
export function fixtureOriginFor(host: string, port: number): string {
  const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${name}:${port}`
}

export function buildFixtureWikiDeps(options: FixtureOptions): FixtureWikiTarget {
  const now = options.now ?? (() => Date.now())
  const repo = new FixtureRepo({files: seedFiles(), now})
  const promotion = createPromotion(repo, now, options.runDurationMs ?? FIXTURE_RUN_DURATION_MS)
  repo.promotion = promotion.provider

  const scopes = new AsyncLocalStorage<FaultScope>()
  const armed = new Set<string>(FAULT_PAGE_IDS)
  let vanished: {readonly path: string; readonly content: string} | null = null

  /** Consume a fault: true once per arming. */
  const take = (id: string): boolean => armed.delete(id)

  const scoped = async <T>(kind: FaultScope['kind'], pageId: string | null, run: () => Promise<T>): Promise<T> =>
    scopes.run({kind, pageId, listingBlocked: false}, run)

  repo.hooks.onCall = method => {
    const scope = scopes.getStore()
    if (scope === undefined) return
    if (scope.kind === 'save' && scope.listingBlocked && method === 'listCommitsByPath') {
      throw new FixtureHttpError('Bad Gateway', 502)
    }
    if (scope.kind !== 'save' || scope.pageId === null) return
    const id = scope.pageId
    if (method === 'getRef' && id === IDS.rateLimit && take(id)) {
      throw new FixtureHttpError('API rate limit exceeded', 403, {'retry-after': String(RATE_LIMIT_RETRY_SECONDS)})
    }
    if (method === 'createBlob' && id === IDS.failed && take(id)) throw new FixtureHttpError('Bad Gateway', 502)
    if (method === 'createDispatch' && id === IDS.dispatchFailure && take(id)) throw new FixtureHttpError('Bad Gateway', 502)
  }
  repo.hooks.beforeUpdateRef = () => {
    const scope = scopes.getStore()
    if (scope?.kind === 'save' && scope.pageId === IDS.timeoutLost && take(scope.pageId)) {
      throw new FixtureHttpError('Request timed out', 504)
    }
  }
  repo.hooks.afterUpdateRef = () => {
    const scope = scopes.getStore()
    if (scope?.kind === 'save' && scope.pageId === IDS.timeoutLanded && take(scope.pageId)) {
      scope.listingBlocked = true
      throw new FixtureHttpError('Request timed out', 504)
    }
  }

  const checkContract = async (): Promise<GateContractDecision> => {
    const scope = scopes.getStore()
    const id = scope?.pageId
    if (id === IDS.contractMismatch) return MISMATCH_CONTRACT
    if (id === IDS.contractUnreadable && armed.has(id)) {
      if (scope?.kind === 'save') armed.delete(id)
      return UNREADABLE_CONTRACT
    }
    return OK_CONTRACT
  }

  const client = createWikiDataClient(repo.transport(), {blobCache: createBlobCache()})
  const realPages = createWikiPages({client, checkContract})
  const dispatch = createDispatchPort({client})
  const realOperation = createWikiWriteOperation({client, checkContract, dispatch, now})
  const status = createPromotionStatusReader({client, now})

  /** Another writer changes the page after the editor opened it. */
  function changePageUpstream(id: string): void {
    const path = pathOfId(id)
    const current = repo.files()[path]
    if (current === undefined) return
    repo.pipelineCommit({[path]: `${current.trimEnd()}\n\nUpdated upstream by another writer.\n`}, 'chore(pipeline): refresh page')
  }

  /**
   * Another writer inserts a line above the paragraphs and changes the middle line.
   * Each arming flips the middle line between its two wordings and adds the inserted
   * line only when absent, so the page text changes on every arming.
   */
  function changePageConflictUpstream(id: string): void {
    const path = pathOfId(id)
    const current = repo.files()[path]
    if (current === undefined) return
    let next = current.includes(PAGE_CONFLICT_INSERTED)
      ? current
      : current.replace(`${PAGE_CONFLICT_HEADING}\n`, `${PAGE_CONFLICT_HEADING}\n\n${PAGE_CONFLICT_INSERTED}\n`)
    if (next.includes(PAGE_CONFLICT_MIDDLE_BASE)) {
      next = next.replace(PAGE_CONFLICT_MIDDLE_BASE, PAGE_CONFLICT_MIDDLE_UPSTREAM)
    } else if (next.includes(PAGE_CONFLICT_MIDDLE_UPSTREAM)) {
      next = next.replace(PAGE_CONFLICT_MIDDLE_UPSTREAM, PAGE_CONFLICT_MIDDLE_BASE)
    }
    if (next === current) next = `${current.trimEnd()}\n\nUpdated upstream by another writer.\n`
    repo.pipelineCommit({[path]: next}, 'chore(pipeline): refresh page')
  }

  /** Another writer adds a correction on the page. */
  function changeCorrectionsUpstream(): void {
    const files = repo.files()
    const file = parseCorrections(files[CORRECTIONS_PATH] ?? 'version: 1\ncorrections: []\n')
    const next = {
      ...file,
      corrections: [...file.corrections, correctionRecord('fixture-correction-upstream', CONFLICT_NODE_ID, UPSTREAM_SPAN, 'pipeline')],
    }
    repo.pipelineCommit({[CORRECTIONS_PATH]: serializeCorrections(next)}, 'chore(pipeline): update corrections')
  }

  /** The page is removed, with its index entry, as a pipeline run would. */
  function removePageUpstream(id: string): void {
    const path = pathOfId(id)
    const files = repo.files()
    const content = files[path]
    if (content === undefined) return
    const remaining = wikiPagePaths(files)
    delete remaining[path]
    vanished = {path, content}
    repo.pipelineCommit({[WIKI_INDEX_PATH]: rebuiltIndex(files, remaining)}, 'chore(pipeline): remove page', [path])
  }

  function restoreVanishedPage(): void {
    if (vanished === null) return
    const {path, content} = vanished
    vanished = null
    const files = repo.files()
    const pages = {...wikiPagePaths(files), [path]: content}
    repo.pipelineCommit({[path]: content, [WIKI_INDEX_PATH]: rebuiltIndex(files, pages)}, 'chore(pipeline): restore page')
  }

  function beforeSave(input: unknown): void {
    const id = pageIdOf(input)
    if (id === null) return
    if (id === IDS.conflict && armed.has(id)) {
      take(id)
      changePageUpstream(id)
    } else if (id === IDS.pageConflict && armed.has(id)) {
      take(id)
      changePageConflictUpstream(id)
    } else if (id === IDS.correctionsConflict && carriesCorrectionChange(input) && armed.has(id)) {
      take(id)
      changeCorrectionsUpstream()
    } else if (id === IDS.vanishes && armed.has(id) && resolvePagePath(id, new Set(Object.keys(repo.files()))) !== null) {
      take(id)
      removePageUpstream(id)
    }
  }

  const pages: WikiPages = {
    listPages: async () => {
      restoreVanishedPage()
      return scoped('list', null, async () => realPages.listPages())
    },
    readPage: async (id, access) => scoped('read', id, async () => realPages.readPage(id, access)),
  }

  const operation: WikiWriteOperation = {
    save: async (input, context) => {
      const id = pageIdOf(input)
      const wasArmed = id !== null && armed.has(id)
      beforeSave(input)
      const result = await scoped('save', id, async () => realOperation.save(input, context))
      // A save that went through cleanly arms the page's fault again for its next save.
      if (id !== null && FAULT_PAGE_IDS.has(id) && !wasArmed && (result.state === 'saved' || result.state === 'saved-not-promoted')) {
        armed.add(id)
      }
      return result
    },
    lookup: async input => scoped('lookup', input.pageId, async () => realOperation.lookup(input)),
  }

  return {
    deps: {
      pages,
      write: {operation, dispatch, status},
      policy: {
        capability: {enabled: true, operatorId: null, dashboardOrigin: options.dashboardOrigin},
        fixtureOperatorLogin: options.operatorLogin,
      },
    },
    repo,
    promotion,
  }
}
