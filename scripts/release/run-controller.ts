import type {Handoff} from './recovery.ts'
import {Buffer} from 'node:buffer'
import {execFile} from 'node:child_process'
import {constants} from 'node:fs'
import {open, realpath, stat} from 'node:fs/promises'
import {isAbsolute, join, resolve} from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'
import {finish, inspect, type ControllerPorts, type Observation, type SkipReason} from './controller.ts'

const repo = 'fro-bot/dashboard'
const ref = 'refs/heads/main'
const workflow = '.github/workflows/held-release.yaml'
const workflowRef = `${repo}/${workflow}@${ref}`
const ownerId = 831617
const sha = /^[a-f0-9]{40}$/u
const digest = /^sha256:[a-f0-9]{64}$/u
const version = /^\d{4}\.\d{2}\.\d+$/u
const runId = /^[1-9]\d{0,14}$/u
const integer = /^[1-9]\d{0,8}$/u
const handoffReasons = new Set(['source-or-predecessor-invalid', 'allocations-unknown', 'draft-unknown', 'version-unknown', 'allocation-invalid', 'candidate-unknown', 'candidate-invalid', 'version-unproven', 'version-conflict', 'candidate-ambiguous', 'draft-conflict'])

export interface ControllerConfig {
  mode: 'prepare' | 'active'
  activation: string | null
  revision: string
  runId: number
  attempt: number
  repositoryId: number
  event: 'push' | 'schedule' | 'workflow_run' | 'workflow_dispatch'
  actorId: number | null
  schedule: string | null
  ownerId: 831617
  readToken: string
  appToken: string
  appId: number
  appSlug: string
}

export interface ControllerDependencies {
  /** Independently read the checkout HEAD, never an environment variable. */
  head: () => Promise<string>
  /** Read the static tracked workflow at revision and its activation from Git history. */
  settings: (revision: string) => Promise<{active: boolean | null; activation: string | null}>
  /** Resolve the owner's numeric ID independently through the public GitHub API. */
  ownerId: () => Promise<number | null>
  /** Read only the schedule field of the runner's trusted GITHUB_EVENT_PATH. */
  schedule: (eventPath: string) => Promise<string | null>
  start: (config: ControllerConfig) => Promise<{ports: ControllerPorts; handoff: (source: string, recovery: boolean) => Promise<Handoff>}>
  write: (path: string, content: string) => Promise<void>
  output: (content: string) => Promise<void>
  summary: (content: string) => Promise<void>
}

export interface NodeControllerSeams {
  cwd?: string
  fetch?: typeof globalThis.fetch
}

const exec = promisify(execFile)
const unknownSettings = () => ({active: null, activation: null})

/** Deliberately accepts only one literal top-level env mapping and scalar. */
function activeSetting(text: string): boolean | null {
  if (text.length > 262144 || text.includes('\t')) return null
  const lines = text.split(/\r?\n/u)
  if (lines.filter(line => /^env\s*:/u.test(line)).length !== 1 || lines.filter(line => /^env:\s*(?:#.*)?$/u.test(line)).length !== 1 ||
    lines.filter(line => /^\s*HELD_RELEASE_ACTIVE\s*:/u.test(line)).length !== 1) return null
  const start = lines.findIndex(line => /^env:\s*(?:#.*)?$/u.test(line))
  const lineIndex = lines.findIndex(line => /^\s*HELD_RELEASE_ACTIVE\s*:/u.test(line))
  if (lineIndex <= start || lines.slice(start + 1, lineIndex).some(line => /^(?!\s|#|$)/u.test(line))) return null
  const match = /^ {2}HELD_RELEASE_ACTIVE: (true|false|"true"|"false"|'true'|'false')\s*$/u.exec(lines[lineIndex] ?? '')
  return match ? match[1]?.replaceAll(/["']/gu, '') === 'true' : null
}

/** Bounded I/O adapters; the caller supplies the independently verified runtime. */
export function nodeControllerDependencies(env: Record<string, string | undefined>, start: ControllerDependencies['start'], seams: NodeControllerSeams = {}): ControllerDependencies {
  const cwd = seams.cwd ?? process.cwd()
  const git = async (...args: string[]) => (await exec('/usr/bin/git', args, {cwd, timeout: 5000, maxBuffer: 262144, env: {PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C'}})).stdout
  const head = async () => (await git('rev-parse', '--verify', 'HEAD')).trim()
  const content = async (revision: string) => git('show', `${revision}:${workflow}`)
  const readBounded = async (path: string, limit: number): Promise<string> => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > limit) throw new Error('invalid file')
      const buffer = Buffer.alloc(limit + 1)
      const {bytesRead} = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > limit) throw new Error('large file')
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  }
  const append = async (path: string | undefined, text: string) => {
    if (path === undefined || !isAbsolute(path) || text.length > 8192 || [...text].some(c => (c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t') || c.charCodeAt(0) === 127)) throw new Error('invalid output')
    const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
    try {
      if (!(await file.stat()).isFile()) throw new Error('invalid output')
      await file.writeFile(text)
    } finally {
      await file.close()
    }
  }
  return {
    head,
    settings: async revision => {
      try {
        if (!sha.test(revision) || await head() !== revision || (await git('rev-parse', '--is-shallow-repository')).trim() !== 'false') return unknownSettings()
        const active = activeSetting(await content(revision))
        if (active === null || env.HELD_RELEASE_ACTIVE !== String(active)) return unknownSettings()
        if (!active) return {active: false, activation: null}
        const log = await git('log', '--full-history', '--first-parent', '--format=%H %cI', revision, '--', workflow)
        if (!log.endsWith('\n')) return unknownSettings()
        const entries = log.trim().split('\n')
        let earliest: string | null = null
        for (const entry of entries) {
          const match = /^([a-f0-9]{40}) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d))$/u.exec(entry)
          if (!match || match[1] === undefined || match[2] === undefined || !Number.isFinite(Date.parse(match[2]))) return unknownSettings()
          const state = activeSetting(await content(match[1]))
          if (state === null) return unknownSettings()
          if (!state) return earliest === null ? unknownSettings() : {active: true, activation: earliest}
          earliest = match[2]
        }
        return unknownSettings()
      } catch {
        return unknownSettings()
      }
    },
    ownerId: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await (seams.fetch ?? fetch)('https://api.github.com/users/marcusrbrown', {headers: {'User-Agent': 'fro-bot-dashboard-release', Accept: 'application/vnd.github+json'}, redirect: 'error', signal: controller.signal})
        if (!response.ok || response.body === null) return null
        const reader = (response.body as ReadableStream<Uint8Array>).getReader()
        let data = ''
        let bytes = 0
        while (true) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > 16384) {
            await reader.cancel()
            return null
          }
          data += new TextDecoder().decode(part.value, {stream: true})
        }
        const value: unknown = JSON.parse(data)
        if (typeof value !== 'object' || value === null || !('login' in value) || !('id' in value) || !('type' in value)) return null
        return value.login === 'marcusrbrown' && value.id === ownerId && value.type === 'User' ? ownerId : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    schedule: async path => {
      try {
        if (!isAbsolute(path) || path !== env.GITHUB_EVENT_PATH) return null
        const value: unknown = JSON.parse(await readBounded(path, 65536))
        if (typeof value !== 'object' || value === null || !('schedule' in value) || typeof value.schedule !== 'string') return null
        return value.schedule === '0 15 * * 0' || value.schedule === '0 15 * * 3' ? value.schedule : null
      } catch {
        return null
      }
    },
    start,
    write: async (path, data) => {
      const temp = env.RUNNER_TEMP
      if (temp === undefined || !isAbsolute(temp) || resolve(path) !== join(resolve(temp), 'release-authorization.json') || await realpath(temp) !== resolve(temp) || !(await stat(temp)).isDirectory() || data.length > 65536) throw new Error('invalid authorization path')
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await file.writeFile(data)
      } finally {
        await file.close()
      }
    },
    output: async data => append(env.GITHUB_OUTPUT, data),
    summary: async data => append(env.GITHUB_STEP_SUMMARY, data),
  }
}

function safeHandoff(h: Handoff, source: string, recovery: boolean): string | null {
  if (h.kind !== 'handoff' || h.source !== source || h.recovery !== recovery || !sha.test(source) ||
    !sha.test(h.predecessor.source) || !version.test(h.version) || !version.test(h.predecessor.version) ||
    !digest.test(h.predecessor.digest) || (h.action !== 'build' && h.action !== 'gate')) return null
  const original = h.original
  if (h.action === 'gate' ? !original || !runId.test(String(original.runId)) || !integer.test(String(original.attempt)) || !digest.test(original.digest) : original !== null) return null
  const origin = original ? `original-run-id=${original.runId}\noriginal-attempt=${original.attempt}\noriginal-digest=${original.digest}\noriginal-verified=true\n` : ''
  return `source=${source}\nversion=${h.version}\naction=${h.action}\npredecessor-version=${h.predecessor.version}\npredecessor-digest=${h.predecessor.digest}\n${origin}recovery=${recovery}\n`
}

function expectedWait(reason: SkipReason, o: Observation | null): boolean {
  switch (reason) {
    case 'disabled':
    case 'prepare-only':
      return true
    case 'candidate':
      return o?.candidate.state === 'not-needed'
    case 'checks':
      return o?.candidate.state === 'ready' && o.candidate.gate.checks !== null && o.candidate.gate.checks.verified
    case 'trigger':
      return o?.trigger.kind === 'push'
    case 'review':
      return (o?.trigger.kind === 'review' || o?.trigger.kind === 'dispatch') && o.trigger.reviewsVerified
    case 'hold':
      return o?.trigger.kind === 'schedule' && o.trigger.hold.verified && o.trigger.hold.state !== 'unknown'
    case 'slot':
      return o?.trigger.kind === 'schedule' && Number.isFinite(Date.parse(o.trigger.originalRunAt)) && Number.isFinite(Date.parse(o.trigger.now))
    case 'inactive':
    case 'unresolved':
    case 'untrusted-run':
    case 'predecessor':
    case 'prior-unknown':
    case 'authorization-invalid':
    case 'squash-unproven':
    case 'observation-changed':
    case 'observation-failed':
    case 'recheck-failed':
      return false
  }
}

export async function runController(args: string[], env: Record<string, string | undefined>, deps: ControllerDependencies): Promise<0 | 1> {
  let provedSource: string | null = null
  const report = async (status: string, code: 0 | 1): Promise<0 | 1> => {
    try {
      await deps.summary(`### Held release\n\n${status}${provedSource === null ? '' : `\n\n- Source: \`${provedSource}\``}\n`)
      return code
    } catch {
      return 1
    }
  }
  const stop = async (reason: string) => report(`Stopped: ${reason}.`, 1)
  try {
    const command = args[0]
    if (!((command === 'inspect' && args.length === 1) || (command === 'finish' && args.length === 2 && runId.test(args[1] ?? '')))) return await stop('invalid-command')
    const revision = env.RELEASE_WORKFLOW_SHA ?? ''
    const event = env.GITHUB_EVENT_NAME
    if (env.GITHUB_REPOSITORY !== repo || env.GITHUB_REF !== ref || env.RELEASE_WORKFLOW_REF !== workflowRef || !sha.test(revision) ||
      !runId.test(env.GITHUB_RUN_ID ?? '') || !integer.test(env.GITHUB_RUN_ATTEMPT ?? '') || !runId.test(env.GITHUB_REPOSITORY_ID ?? '') ||
      (event !== 'push' && event !== 'schedule' && event !== 'workflow_run' && event !== 'workflow_dispatch') ||
      (event === 'workflow_dispatch' && (env.RELEASE_ACTOR_ID !== String(ownerId) || env.GITHUB_RUN_ATTEMPT !== '1'))) return await stop('untrusted-context')
    if (await deps.head() !== revision) return await stop('untrusted-revision')
    const settings = await deps.settings(revision)
    const prepare = env.RELEASE_PREPARE_ONLY === 'true' && event === 'workflow_dispatch'
    if (settings.active !== true && settings.active !== false) return await stop('settings-unknown')
    if (!prepare && settings.active !== true) return await report('Skipped.', 0)
    if (!prepare && (settings.activation === null || !Number.isFinite(Date.parse(settings.activation)))) return await stop('activation-unknown')
    if (await deps.ownerId() !== ownerId) return await stop('owner-unverified')
    const schedule = event === 'schedule' && env.GITHUB_EVENT_PATH !== undefined && env.GITHUB_EVENT_PATH !== '' ? await deps.schedule(env.GITHUB_EVENT_PATH) : null
    if (event === 'schedule' && schedule !== '0 15 * * 0' && schedule !== '0 15 * * 3') return await stop('schedule-unverified')
    const readToken = env.RELEASE_READ_TOKEN
    const appToken = env.RELEASE_APP_TOKEN
    const appId = env.RELEASE_APP_ID ?? ''
    const appSlug = env.RELEASE_APP_SLUG ?? ''
    if (readToken === undefined || readToken === '' || appToken === undefined || appToken === '' || !integer.test(appId) || !/^[a-z0-9-]+$/u.test(appSlug) || env.RUNNER_TEMP === undefined || env.RUNNER_TEMP === '' || env.GITHUB_OUTPUT === undefined || env.GITHUB_OUTPUT === '') return await stop('configuration-invalid')
    const config: ControllerConfig = {mode: prepare ? 'prepare' : 'active', activation: settings.activation, revision, runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), repositoryId: Number(env.GITHUB_REPOSITORY_ID), event, actorId: event === 'workflow_dispatch' ? ownerId : null, schedule, ownerId, readToken, appToken, appId: Number(appId), appSlug}
    const runtime = await deps.start(config)
    let observed: Observation | null = null
    const ports: ControllerPorts = {...runtime.ports, observe: async () => {
      const o = await runtime.ports.observe()
      const expectedTrigger = event === 'workflow_run' ? 'review' : event === 'workflow_dispatch' ? 'dispatch' : event
      if (o.mode !== config.mode || o.activation !== config.activation || o.ownerId !== ownerId || o.baseBranch !== 'main' ||
        o.trusted.repo !== repo || o.trusted.workflow !== workflow || o.trusted.revision !== revision || o.trusted.appId !== config.appId ||
        o.run.runId !== config.runId || o.run.attempt !== config.attempt || o.trigger.kind !== expectedTrigger ||
        (o.trigger.kind === 'dispatch' && (o.trigger.actorId !== ownerId || o.trigger.ref !== ref)) ||
        (o.trigger.kind === 'schedule' && o.trigger.cron !== schedule)) throw new Error('untrusted observation')
      observed = o
      return o
    }}
    const outcome = command === 'inspect' ? await inspect(ports) : await finish(ports, Number(args[1]))
    if (outcome.kind === 'authorize' && command === 'inspect' && !prepare) {
      await deps.write(join(env.RUNNER_TEMP, 'release-authorization.json'), `${JSON.stringify(outcome.authorization)}\n`)
      await deps.output('authorize=true\n')
      return await report('Authorization prepared.', 0)
    }
    if (outcome.kind === 'source' && !prepare && (command === 'finish' || outcome.recovery)) {
      if (!sha.test(outcome.source)) return await stop('source-invalid')
      provedSource = outcome.source
      const result = await runtime.handoff(outcome.source, outcome.recovery)
      const handoff = safeHandoff(result, outcome.source, outcome.recovery)
      if (handoff !== null) {
        await deps.output(handoff)
        if (result.kind === 'handoff') {
          const candidate = result.original === null ? '' : `\n- Candidate digest: \`${result.original.digest}\``
          return await report(`Source proved.\n\n- Version: \`${result.version}\`\n- Predecessor digest: \`${result.predecessor.digest}\`${candidate}`, 0)
        }
      }
      if (result.kind === 'stop' && handoffReasons.has(result.reason)) return await stop(result.reason)
      return await stop('handoff-invalid')
    }
    if (outcome.kind === 'prepared') return await report('Candidate prepared; publication not authorized.', 0)
    if (outcome.kind === 'skip') return expectedWait(outcome.reason, observed) ? await report(`Skipped: ${outcome.reason}.`, 0) : await stop(outcome.reason)
    return await stop('unexpected-outcome')
  } catch {
    return stop('runtime-failed')
  }
}

if (import.meta.main) {
  process.exitCode = await runController(process.argv.slice(2), process.env, nodeControllerDependencies(process.env, async config => {
    const {startController} = await import('./controller-start.ts')
    return startController(config, process.cwd())
  }))
}
