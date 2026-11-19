/**
 * Publish-only adapter: drives `reconcilePublication` against GitHub releases/refs and GHCR
 * through fixed `gh` and `docker buildx imagetools` commands, for one already-authorized tuple.
 *
 * Not here, by design: authorization, allocation, candidate builds, gate runs, artifact/run
 * provenance, the dispatch to infra and every credential. The trusted U4 controller supplies a
 * typed `PublishInput` (proven source and notes, verified predecessor, authenticated build and gate
 * facts). `verified` is taken from that input and is never inferred from a release body, an
 * artifact name, an event SHA or a flag. The adapter refuses allocate/build/gate handoffs.
 *
 * Reads: absence only on an authoritative success. A tag is absent when `matching-refs` succeeds
 * with no exact ref (a 404 can hide access denial, so it is unknown), and an image alias is absent
 * only when the runner output is exactly the precise `<ref>: not found` for the requested manifest.
 * Anything else is unknown. Writes: only the exact authorized tuple, one
 * attempt each, never a delete; `reconcilePublication` re-reads after every write, so a lost
 * response converges or stops. Raw stderr and error text never leave this module.
 *
 * Deploy: `dispatch` is reported `never-sent` because nothing can have been dispatched before the
 * first verified publication. `reconcilePublication` offers a deploy only to a fresh
 * `run_attempt === 1` invocation that created the draft, so every other run reports `not-fresh`.
 *
 * CLI: `node scripts/release/publisher.ts <input.json>` with `GITHUB_RUN_ATTEMPT` set (and optionally
 * `GITHUB_REPOSITORY`, which must then match). Prints one JSON line. Exit 0 complete, 1 stopped
 * (stable `reason` only), 2 unusable invocation/input (nothing was run).
 */
import type {Artifacts, ArtifactTarget, Build, Evidence, Identity, Known, Obs, Outcome, PublicationPorts, Records, ReleaseRecord} from './publication.ts'
import type {ReceiptBot, ReceiptIdentity} from './release-receipt.ts'

import {execFile} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {createGitHubApi} from './github-release-api.ts'
import {reconcilePublication} from './publication.ts'
import {readReleaseReceipt, uploadReleaseReceipt} from './release-receipt.ts'

export interface CommandResult {status: number; stdout: string; stderr: string}
export type Runner = (command: 'gh' | 'docker', args: readonly string[]) => Promise<CommandResult>

export interface PublishInput {
  /** `owner/name` of the repository holding both the releases and the GHCR package. */
  repo: string
  /** Squash proven by the controller (`proveSquash`). */
  source: string
  /** Notes committed at `source`. */
  notes: string
  /** Verified release this batch advances from. */
  predecessor: {version: string; digest: string}
  /** Authenticated candidate records; `verified` comes from the controller. */
  builds: Known<Build[]>
  /** Authenticated gate records (smoke and enforced Trivy); `verified` comes from the controller. */
  evidence: Known<Evidence[]>
}

export type PublishOutcome = Extract<Outcome, {kind: 'stop' | 'complete'}>

const SHA = /^(?:[\da-f]{40}|[\da-f]{64})$/u
const DIGEST = /^sha256:[\da-f]{64}$/u
const CALVER = /^\d{4}\.\d{2}\.\d+$/u
const REPO = /^[\w.-]+\/[\w.-]+$/u
const MARKER = '\n\n## Image\n\n'
const UNKNOWN_REASONS = ['read-failed', 'ambiguous', 'malformed'] as const

const normalize = (text: string) => text.replaceAll('\r\n', '\n')
/**
 * Demonstrated absence of exactly this manifest: every stderr line is the requested reference with the
 * `: not found` terminator (buildx prefixes `ERROR: `). A helper, host or other-ref not-found is not it.
 * The live stderr contract is unverified against real GHCR; a different wording is unknown (safe).
 */
function manifestNotFound(stderr: string, reference: string): boolean {
  const lines = stderr.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.length > 0 && lines.every(line => line === `${reference}: not found` || line === `ERROR: ${reference}: not found`)
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const image = (repo: string) => `ghcr.io/${repo.toLowerCase()}`

export function renderReleaseBody(repo: string, identity: Identity): string {
  const ref = image(repo)
  return `${normalize(identity.notes)}${MARKER}Image: ${ref}:${identity.version}\nDigest: ${ref}@${identity.digest}\nSource: ${identity.source}`
}

/** The image block is the only identity; a body that deviates in any way has none. */
export function parseReleaseBody(repo: string, body: string): Identity | null {
  const text = normalize(body)
  const at = text.lastIndexOf(MARKER)
  if (at === -1) return null
  const lines = text.slice(at + MARKER.length).replace(/\n$/u, '').split('\n')
  const ref = image(repo)
  const [imageLine, digestLine, sourceLine] = lines
  if (lines.length !== 3 || imageLine === undefined || digestLine === undefined || sourceLine === undefined) return null
  if (!imageLine.startsWith(`Image: ${ref}:`) || !digestLine.startsWith(`Digest: ${ref}@`) || !sourceLine.startsWith('Source: ')) return null
  const version = imageLine.slice(`Image: ${ref}:`.length)
  const digest = digestLine.slice(`Digest: ${ref}@`.length)
  const source = sourceLine.slice('Source: '.length)
  if (!CALVER.test(version) || !DIGEST.test(digest) || !SHA.test(source)) return null
  return {version, source, digest, notes: text.slice(0, at)}
}

interface ReleaseRead {id: number; tag: string; draft: boolean; identity: Identity | null; author: unknown}

const unknown = (reason: (typeof UNKNOWN_REASONS)[number]) => ({state: 'unknown', reason}) as const
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function toRelease(repo: string, value: unknown): ReleaseRead | null {
  if (!isObject(value) || !positive(value.id) || typeof value.tag_name !== 'string' || typeof value.draft !== 'boolean') return null
  if (value.body !== null && typeof value.body !== 'string') return null
  return {id: value.id, tag: value.tag_name, draft: value.draft, identity: parseReleaseBody(repo, value.body ?? ''), author: value.author}
}

export interface ReceiptDeps {
  bot: ReceiptBot
  read: (expected: ReceiptIdentity, bot: ReceiptBot) => Promise<Obs<ReceiptIdentity>>
  upload: (expected: ReceiptIdentity) => Promise<void>
}

export function createPublicationPorts(input: PublishInput, run: Runner, receipt?: ReceiptDeps): PublicationPorts {
  const {repo, source} = input
  const ref = image(repo)
  const notes = normalize(input.notes)
  const send = async (command: 'gh' | 'docker', args: readonly string[]): Promise<CommandResult | null> => {
    try {
      return await run(command, args)
    } catch {
      return null
    }
  }

  // Gate facts the controller authenticated, for this source only. A pass counts only while no
  // record for the same version, source and digest contradicts it (failed, unverified or not
  // enforced); contradiction refuses every write for that digest and leaves other digests alone.
  const proves = (e: Evidence) => e.verified && e.smoke === 'pass' && e.trivy.enforced && e.trivy.result === 'pass'
  const passing = (): Evidence[] => {
    const records = input.evidence.state === 'present' ? input.evidence.value.filter(e => e.source === source && DIGEST.test(e.digest) && CALVER.test(e.version)) : []
    return records.filter(e => proves(e) && records.every(other => other.version !== e.version || other.digest !== e.digest || proves(other)))
  }
  const authorized = (version: string | null, digest: string) => passing().some(e => e.digest === digest && (version === null || e.version === version))
  const refuse = (): never => {
    throw new Error('refused')
  }

  async function readReleases(): Promise<Known<ReleaseRead[]>> {
    const result = await send('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])
    if (result === null || result.status !== 0) return unknown('read-failed')
    const pages = parseJson(result.stdout)
    if (!Array.isArray(pages)) return unknown('malformed')
    const releases: ReleaseRead[] = []
    for (const page of pages) {
      if (!Array.isArray(page)) return unknown('malformed')
      for (const item of page) {
        const release = toRelease(repo, item)
        if (release === null) return unknown('malformed')
        releases.push(release)
      }
    }
    return {state: 'present', value: releases}
  }

  async function readTag(version: string): Promise<Obs<{sha: string}>> {
    if (!CALVER.test(version)) return unknown('malformed')
    // Documented list endpoint: https://docs.github.com/en/rest/git/refs#list-matching-references
    // It matches by prefix, so only the exact ref counts. Any non-success (a 404 can hide access
    // denial) is unknown; absence is an authoritative empty exact match over a fully valid list.
    const result = await send('gh', ['api', '--paginate', '--slurp', `repos/${repo}/git/matching-refs/tags/${version}`])
    if (result === null || result.status !== 0) return unknown('read-failed')
    const pages = parseJson(result.stdout)
    if (!Array.isArray(pages)) return unknown('malformed')
    const exact: {sha: string; type: string}[] = []
    for (const page of pages) {
      if (!Array.isArray(page)) return unknown('malformed')
      for (const entry of page) {
        const object = isObject(entry) ? entry.object : undefined
        if (!isObject(entry) || typeof entry.ref !== 'string' || !entry.ref.startsWith('refs/tags/')) return unknown('malformed')
        if (!isObject(object) || typeof object.sha !== 'string' || !SHA.test(object.sha) || typeof object.type !== 'string') return unknown('malformed')
        if (entry.ref === `refs/tags/${version}`) exact.push({sha: object.sha, type: object.type})
      }
    }
    const [only] = exact
    if (only === undefined) return {state: 'absent'}
    // An annotated tag object or a duplicate is not a commit ref we can compare to the source.
    return exact.length === 1 && only.type === 'commit' ? {state: 'present', value: {sha: only.sha}} : unknown('malformed')
  }

  async function readImage(tag: string): Promise<Obs<{digest: string}>> {
    const result = await send('docker', ['buildx', 'imagetools', 'inspect', `${ref}:${tag}`, '--format', '{{.Manifest.Digest}}'])
    if (result === null) return unknown('read-failed')
    if (result.status !== 0) return result.stdout.trim() === '' && manifestNotFound(result.stderr, `${ref}:${tag}`) ? {state: 'absent'} : unknown('read-failed')
    const digest = result.stdout.trim()
    return DIGEST.test(digest) ? {state: 'present', value: {digest}} : unknown('malformed')
  }

  /** The one draft for `version`, re-read by release id, that matches the authorized tuple. */
  async function authorizedRelease(version: string, draft: boolean): Promise<ReceiptIdentity> {
    const list = await readReleases()
    if (list.state !== 'present') return refuse()
    const matching = list.value.filter(r => r.tag === version)
    const [listed] = matching
    if (matching.length !== 1 || listed === undefined || listed.draft !== draft) return refuse()
    const same = (r: ReleaseRead) => receipt !== undefined && isObject(r.author) && r.author.id === receipt.bot.id && r.author.login === receipt.bot.login && r.author.type === 'Bot' &&
      positive(receipt.bot.id) && r.tag === version && r.identity?.version === version && r.identity.source === source && r.identity.notes === notes && authorized(version, r.identity.digest)
    if (!same(listed)) return refuse()
    const result = await send('gh', ['api', `repos/${repo}/releases/${listed.id}`])
    const fresh = result !== null && result.status === 0 ? toRelease(repo, parseJson(result.stdout)) : null
    if (fresh === null || fresh.id !== listed.id || fresh.draft !== draft || !same(fresh) || fresh.identity?.digest !== listed.identity?.digest || fresh.identity === null) return refuse()
    return {repo, releaseId: listed.id, version, source, digest: fresh.identity.digest}
  }

  const receiptMatches = async (expected: ReceiptIdentity) => {
    if (!receipt || !positive(receipt.bot.id) || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\[bot\]$/u.test(receipt.bot.login)) return false
    const observed = await receipt.read(expected, receipt.bot)
    return observed.state === 'present' && Object.keys(expected).every(key => observed.value[key as keyof ReceiptIdentity] === expected[key as keyof ReceiptIdentity])
  }
  let receiptFailed = false

  const write = async (command: 'gh' | 'docker', args: readonly string[]) => {
    const result = await send(command, args)
    if (result === null || result.status !== 0) throw new Error('write-failed')
  }

  return {
    async observeRecords(): Promise<Records> {
      if (receiptFailed) return refuse()
      const list = await readReleases()
      if (list.state === 'present') {
        for (const release of list.value.filter(r => !r.draft && r.identity?.source === source)) {
          const expected = await authorizedRelease(release.tag, false)
          if (!(await receiptMatches(expected))) return refuse()
        }
      }
      // `verified` stays false: a body that parses proves syntax, not a gated or settled publication.
      // Any other-batch record is therefore unresolved until the U4 controller supplies proved state.
      const releases: Known<ReleaseRecord[]> = list.state === 'present' ? {state: 'present', value: list.value.map(r => ({tag: r.tag, draft: r.draft, verified: false, identity: r.identity}))} : list
      return {expected: {source, notes}, predecessor: input.predecessor, releases, builds: input.builds, evidence: input.evidence}
    },

    async observeArtifacts(target: ArtifactTarget): Promise<Artifacts> {
      const [tagRef, versionAlias, shaAlias, latest] = await Promise.all([readTag(target.version), readImage(target.version), readImage(target.shaAlias), readImage('latest')])
      // Never sent before the first verified publication; a deploy is offered only to a fresh original attempt.
      return {target, tagRef, versionAlias, shaAlias, latest, dispatch: {state: 'present', value: 'never-sent'}}
    },

    async apply(action: Parameters<PublicationPorts['apply']>[0]): Promise<void> {
      switch (action.kind) {
        case 'create-draft': {
          const {identity} = action
          if (!CALVER.test(identity.version) || identity.source !== source || normalize(identity.notes) !== notes || !authorized(identity.version, identity.digest)) return refuse()
          // The releases API needs Workflows write when the target's workflow files differ from the
          // default branch; no grant is added here, and the U4 preflight must block on a denial.
          return write('gh', [
            'api', '--method', 'POST', `repos/${repo}/releases`,
            '-f', `tag_name=${identity.version}`,
            '-f', `target_commitish=${source}`,
            '-f', `name=${identity.version}`,
            '-f', `body=${renderReleaseBody(repo, identity)}`,
            '-F', 'draft=true',
          ])
        }
        case 'create-tag':
          if (!CALVER.test(action.version) || action.source !== source || !passing().some(e => e.version === action.version)) return refuse()
          return write('gh', ['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${action.version}`, '-f', `sha=${source}`])
        case 'create-alias': {
          const expected = action.alias === 'sha' ? `sha-${source.slice(0, 7)}` : action.name
          const named = action.alias === 'sha' ? action.name === expected && authorized(null, action.digest) : CALVER.test(action.name) && authorized(action.name, action.digest)
          if (!named || !DIGEST.test(action.digest)) return refuse()
          return write('docker', ['buildx', 'imagetools', 'create', '--tag', `${ref}:${action.name}`, `${ref}@${action.digest}`])
        }
        case 'publish-release': {
          // Refuse on gate proof before any read; the draft's own digest is re-checked after listing.
          if (!CALVER.test(action.version) || !passing().some(e => e.version === action.version)) return refuse()
          const expected = await authorizedRelease(action.version, true)
          try {
            if (!receipt || !positive(receipt.bot.id) || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\[bot\]$/u.test(receipt.bot.login)) return refuse()
            const observed = await receipt.read(expected, receipt.bot)
            if (observed.state === 'absent') {
              await receipt.upload(expected)
              if (!(await receiptMatches(expected))) return refuse()
            } else if (observed.state !== 'present' || !Object.keys(expected).every(key => observed.value[key as keyof ReceiptIdentity] === expected[key as keyof ReceiptIdentity])) return refuse()
            const fresh = await authorizedRelease(action.version, true)
            if (JSON.stringify(fresh) !== JSON.stringify(expected)) return refuse()
          } catch {
            receiptFailed = true
            return refuse()
          }
          return write('gh', ['api', '--method', 'PATCH', `repos/${repo}/releases/${expected.releaseId}`, '-F', 'draft=false'])
        }
        case 'set-latest':
          if (!DIGEST.test(action.digest) || !authorized(null, action.digest)) return refuse()
          {
            const versions = passing().filter(e => e.digest === action.digest).map(e => e.version)
            if (new Set(versions).size !== 1 || versions[0] === undefined) return refuse()
            const expected = await authorizedRelease(versions[0], false)
            if (expected.digest !== action.digest || !(await receiptMatches(expected))) return refuse()
          }
          return write('docker', ['buildx', 'imagetools', 'create', '--tag', `${ref}:latest`, `${ref}@${action.digest}`])
        case 'allocate':
          // Allocation is a workflow/controller duty, never an adapter write.
          return refuse()
      }
    },
  }
}

// Only stable identifiers leave this module: planner details can echo remote tag names.
const safeDetail = (detail: string | undefined) => (detail === undefined ? {} : {detail: /^[\w.:-]{1,64}$/u.test(detail) ? detail : 'redacted'})

export async function publishRelease(input: PublishInput, run: Runner, attempt: number, receipt?: ReceiptDeps): Promise<PublishOutcome> {
  if (!positive(attempt)) return {kind: 'stop', reason: 'attempt-unverified'}
  const outcome = await reconcilePublication(createPublicationPorts(input, run, receipt), {attempt})
  if (outcome.kind === 'complete') return outcome
  if (outcome.kind === 'handoff') return {kind: 'stop', reason: 'handoff-refused', detail: outcome.action.kind}
  if (outcome.reason === 'write-unconfirmed' && outcome.detail === 'allocate') return {kind: 'stop', reason: 'allocate-refused'}
  return {kind: 'stop', reason: outcome.reason, ...safeDetail(outcome.detail)}
}

function parseKnown<T>(value: unknown, item: (entry: unknown) => T | null): Known<T[]> | null {
  if (!isObject(value)) return null
  if (value.state === 'unknown') {
    const reason = UNKNOWN_REASONS.find(r => r === value.reason)
    return Object.keys(value).length === 2 && reason !== undefined ? unknown(reason) : null
  }
  if (value.state !== 'present' || Object.keys(value).length !== 2 || !Array.isArray(value.value)) return null
  const items = value.value.map(item)
  return items.every(entry => entry !== null) ? {state: 'present', value: items} : null
}

function parseBuild(entry: unknown): Build | null {
  if (!isObject(entry) || !positive(entry.runId) || !positive(entry.attempt) || typeof entry.version !== 'string' || !CALVER.test(entry.version)) return null
  if (typeof entry.source !== 'string' || !SHA.test(entry.source) || typeof entry.verified !== 'boolean') return null
  if (entry.digest !== null && (typeof entry.digest !== 'string' || !DIGEST.test(entry.digest))) return null
  return {runId: entry.runId, attempt: entry.attempt, version: entry.version, source: entry.source, digest: entry.digest, verified: entry.verified}
}

function parseEvidence(entry: unknown): Evidence | null {
  if (!isObject(entry) || !positive(entry.runId) || !positive(entry.attempt) || typeof entry.version !== 'string' || !CALVER.test(entry.version)) return null
  if (typeof entry.source !== 'string' || !SHA.test(entry.source) || typeof entry.digest !== 'string' || !DIGEST.test(entry.digest) || typeof entry.verified !== 'boolean') return null
  const trivy = entry.trivy
  if ((entry.smoke !== 'pass' && entry.smoke !== 'fail') || !isObject(trivy) || typeof trivy.enforced !== 'boolean' || (trivy.result !== 'pass' && trivy.result !== 'fail')) return null
  return {runId: entry.runId, attempt: entry.attempt, version: entry.version, source: entry.source, digest: entry.digest, verified: entry.verified, smoke: entry.smoke, trivy: {enforced: trivy.enforced, result: trivy.result}}
}

/** Strict: unknown keys (for example a caller-supplied dispatch state) and non-boolean `verified` are rejected. */
export function parsePublishInput(value: unknown): PublishInput | null {
  const keys = ['repo', 'source', 'notes', 'predecessor', 'builds', 'evidence']
  if (!isObject(value) || Object.keys(value).length !== keys.length || !keys.every(key => key in value)) return null
  const {repo, source, notes, predecessor} = value
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) return null
  if (typeof source !== 'string' || !SHA.test(source) || typeof notes !== 'string') return null
  if (!isObject(predecessor) || Object.keys(predecessor).length !== 2 || typeof predecessor.version !== 'string' || !CALVER.test(predecessor.version) || typeof predecessor.digest !== 'string' || !DIGEST.test(predecessor.digest)) return null
  const builds = parseKnown(value.builds, parseBuild)
  const evidence = parseKnown(value.evidence, parseEvidence)
  if (builds === null || evidence === null) return null
  return {repo, source, notes, predecessor: {version: predecessor.version, digest: predecessor.digest}, builds, evidence}
}

export interface CliDeps {
  run: Runner
  readFile: (path: string) => string
  write: (text: string) => void
  receipt?: (repo: string, token: string, slug: string) => Promise<ReceiptDeps | null>
}

export async function runPublisherCli(argv: readonly string[], env: Record<string, string | undefined>, deps: CliDeps): Promise<number> {
  const usage = (reason: 'usage' | 'invalid-input') => {
    deps.write(`${JSON.stringify({kind: 'error', reason})}\n`)
    return 2
  }
  const [path] = argv
  const attempt = /^[1-9]\d{0,8}$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') ? Number(env.GITHUB_RUN_ATTEMPT) : null
  if (argv.length !== 1 || path === undefined || attempt === null) return usage('usage')
  let parsed: PublishInput | null = null
  try {
    parsed = parsePublishInput(JSON.parse(deps.readFile(path)) as unknown)
  } catch {
    parsed = null
  }
  if (parsed === null || (env.GITHUB_REPOSITORY !== undefined && env.GITHUB_REPOSITORY !== parsed.repo)) return usage('invalid-input')
  let receipt: ReceiptDeps | null = null
  try {
    if (env.GH_TOKEN !== undefined && env.GH_TOKEN !== '' && env.RELEASE_APP_SLUG !== undefined && env.RELEASE_APP_SLUG !== '' && deps.receipt !== undefined) receipt = await deps.receipt(parsed.repo, env.GH_TOKEN, env.RELEASE_APP_SLUG)
  } catch { /* Refuse without exposing remote errors. */ }
  if (receipt === null) {
    deps.write(`${JSON.stringify({kind: 'stop', reason: 'receipt-identity-unverified'})}\n`)
    return 1
  }
  const outcome = await publishRelease(parsed, deps.run, attempt, receipt)
  if (outcome.kind === 'complete') {
    const {version, source, digest} = outcome.identity
    deps.write(`${JSON.stringify({kind: 'complete', version, source, digest, deploy: outcome.deploy})}\n`)
    return 0
  }
  deps.write(`${JSON.stringify(outcome)}\n`)
  return 1
}

type Env = Record<string, string | undefined>
type ExecFile = (
  file: string,
  args: string[],
  options: {encoding: 'utf8'; timeout: number; maxBuffer: number; env: Env},
  done: (error: {code?: number | string | null} | null, stdout: string, stderr: string) => void,
) => unknown

const nodeExecFile: ExecFile = (file, args, options, done) => execFile(file, args, options, (error, stdout, stderr) => done(error, stdout, stderr))
// Credentials for `gh` only. Docker keeps its own registry session (DOCKER_CONFIG / login), nothing else.
const GH_AUTH_ENV = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])

export function createExecRunner(exec: ExecFile = nodeExecFile, env: Env = process.env): Runner {
  const dockerEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !GH_AUTH_ENV.has(name)))
  return async (command, args) =>
    new Promise(done => {
      exec(command, [...args], {encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: command === 'docker' ? dockerEnv : env}, (error, stdout, stderr) => {
        done({status: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr})
      })
    })
}

export const execRunner: Runner = createExecRunner()

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runPublisherCli(process.argv.slice(2), process.env, {
    run: execRunner,
    readFile: path => readFileSync(path, 'utf8'),
    write: text => process.stdout.write(text),
    receipt: async (repo, token, slug) => {
      const api = createGitHubApi({repo, readToken: token, writeToken: token})
      const bot = await api.botUser(slug)
      return bot === null ? null : {bot, read: async (expected, author) => readReleaseReceipt(api, expected, author), upload: async expected => uploadReleaseReceipt(api, expected)}
    },
  })
}
