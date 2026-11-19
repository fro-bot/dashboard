import type {Build, Evidence, Identity} from '../scripts/release/publication.ts'
import type {CommandResult, PublishInput, Runner} from '../scripts/release/publisher.ts'

import {describe, expect, it} from 'vitest'
import {createExecRunner, createPublicationPorts, parsePublishInput, parseReleaseBody, publishRelease, renderReleaseBody, runPublisherCli} from '../scripts/release/publisher.ts'

const REPO = 'fro-bot/dashboard'
const IMAGE = 'ghcr.io/fro-bot/dashboard'
const SOURCE = 'a'.repeat(40)
const SHA_ALIAS = `sha-${SOURCE.slice(0, 7)}`
const VERSION = '2026.11.3'
const NOTES = '## Release\n\n- Add held releases (#1)\n'
const PREDECESSOR = {version: '2026.11.2', digest: `sha256:${'1'.repeat(64)}`}
const DIGEST = `sha256:${'2'.repeat(64)}`
const SECRET = 'ghs_SECRET_TOKEN_VALUE'

const BUILD: Build = {runId: 100, attempt: 1, version: VERSION, source: SOURCE, digest: DIGEST, verified: true}
const EVIDENCE: Evidence = {runId: 100, attempt: 1, version: VERSION, source: SOURCE, digest: DIGEST, verified: true, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}
const IDENTITY: Identity = {version: VERSION, source: SOURCE, digest: DIGEST, notes: NOTES}

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  repo: REPO,
  source: SOURCE,
  notes: NOTES,
  predecessor: PREDECESSOR,
  builds: {state: 'present', value: [BUILD]},
  evidence: {state: 'present', value: [EVIDENCE]},
  ...overrides,
})

const ok = (stdout = ''): CommandResult => ({status: 0, stdout, stderr: ''})
const fail = (stderr: string): CommandResult => ({status: 1, stdout: '', stderr})
const NOT_FOUND = fail('gh: Not Found (HTTP 404)')
const AMBIGUOUS = fail(`gh: Internal Server Error (HTTP 500) Authorization: token ${SECRET}`)

interface Release {id: number; tag: string; draft: boolean; body: string}
type Op = 'create-draft' | 'create-tag' | 'publish' | `alias:${string}`

/** In-memory GitHub + registry that answers only the exact fixed commands the adapter may issue. */
class World {
  releases = new Map<number, Release>()
  refs = new Map<string, string>([[PREDECESSOR.version, 'd'.repeat(40)]])
  images = new Map<string, string>([[PREDECESSOR.version, PREDECESSOR.digest], ['latest', PREDECESSOR.digest]])
  nextId = 1000
  calls: string[] = []
  writes: string[] = []
  /** Applied, but the response is lost. */
  lost = new Set<Op>()
  /** Rejected before applying. */
  dropped = new Set<Op>()
  /** Read keys answered with an ambiguous failure: releases, tag, release:<id>, image:<tag>. */
  unreadable = new Set<string>()
  /** Registry inspect answered with this stderr (status 1) instead of the real state. */
  inspectFailure = new Map<string, string>()

  draft(body = renderReleaseBody(REPO, IDENTITY), tag = VERSION): Release {
    const release = {id: this.nextId++, tag, draft: true, body}
    this.releases.set(release.id, release)
    return release
  }

  private json(release: Release) {
    return {id: release.id, tag_name: release.tag, draft: release.draft, body: release.body, target_commitish: SOURCE}
  }

  private write(op: Op, apply: () => CommandResult): CommandResult {
    this.writes.push(op)
    if (this.dropped.has(op)) return fail(`gh: Bad Gateway (HTTP 502) ${SECRET}`)
    const result = apply()
    return this.lost.has(op) ? fail(`gh: Bad Gateway (HTTP 502) ${SECRET}`) : result
  }

  run: Runner = async (command, args) => {
    this.calls.push(`${command} ${args.join(' ')}`)
    const field = (key: string) => {
      const found = args.find(arg => arg.startsWith(`${key}=`))
      return found === undefined ? undefined : found.slice(key.length + 1)
    }
    if (command === 'gh') {
      if (args.join(' ') === `api --paginate --slurp repos/${REPO}/releases?per_page=100`) {
        if (this.unreadable.has('releases')) return AMBIGUOUS
        return ok(JSON.stringify([[...this.releases.values()].map(r => this.json(r))]))
      }
      const byId = /^repos\/fro-bot\/dashboard\/releases\/(\d+)$/u.exec(args.at(-1) ?? '')
      if (args.length === 2 && args[0] === 'api' && byId) {
        const release = this.releases.get(Number(byId[1]))
        if (this.unreadable.has(`release:${byId[1]}`)) return AMBIGUOUS
        return release ? ok(JSON.stringify(this.json(release))) : NOT_FOUND
      }
      const matching = /^repos\/fro-bot\/dashboard\/git\/matching-refs\/tags\/(.+)$/u.exec(args.at(-1) ?? '')
      if (matching && args.length === 4 && args.slice(0, 3).join(' ') === 'api --paginate --slurp') {
        if (this.unreadable.has('tag')) return AMBIGUOUS
        if (this.unreadable.has('tag-404')) return NOT_FOUND
        if (this.unreadable.has('tag-empty')) return ok('')
        const prefix = matching[1] ?? ''
        const list = [...this.refs].filter(([name]) => name.startsWith(prefix)).map(([name, sha]) => ({ref: `refs/tags/${name}`, node_id: 'n', url: 'u', object: {sha, type: 'commit', url: 'u'}}))
        return ok(JSON.stringify([list]))
      }
      if (args.join(' ').startsWith('api --method POST repos/fro-bot/dashboard/releases ')) {
        return this.write('create-draft', () => {
          const release = this.draft(field('body'), field('tag_name'))
          expect(field('target_commitish')).toBe(SOURCE)
          expect(args).toContain('draft=true')
          return ok(JSON.stringify(this.json(release)))
        })
      }
      if (args.join(' ').startsWith('api --method POST repos/fro-bot/dashboard/git/refs ')) {
        return this.write('create-tag', () => {
          this.refs.set((field('ref') ?? '').replace('refs/tags/', ''), field('sha') ?? '')
          return ok('{}')
        })
      }
      const patch = /^api --method PATCH repos\/fro-bot\/dashboard\/releases\/(\d+) -F draft=false$/u.exec(args.join(' '))
      if (patch) {
        return this.write('publish', () => {
          const release = this.releases.get(Number(patch[1]))
          if (release) release.draft = false
          return ok('{}')
        })
      }
    }
    if (command === 'docker') {
      const inspect = /^buildx imagetools inspect ghcr\.io\/fro-bot\/dashboard:(\S+) --format \{\{\.Manifest\.Digest\}\}$/u.exec(args.join(' '))
      if (inspect) {
        const tag = inspect[1] ?? ''
        if (this.unreadable.has(`image:${tag}`)) return fail('denied: requested access to the resource is denied')
        const failure = this.inspectFailure.get(tag)
        if (failure !== undefined) return fail(failure)
        const digest = this.images.get(tag)
        return digest === undefined ? fail(`${IMAGE}:${tag}: not found`) : ok(`${digest}\n`)
      }
      const create = /^buildx imagetools create --tag ghcr\.io\/fro-bot\/dashboard:(\S+) ghcr\.io\/fro-bot\/dashboard@(sha256:[\da-f]{64})$/u.exec(args.join(' '))
      if (create) {
        return this.write(`alias:${create[1]}`, () => {
          this.images.set(create[1] ?? '', create[2] ?? '')
          return ok()
        })
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  get published() {
    return [...this.releases.values()].filter(r => !r.draft)
  }
}

const noDestructive = (world: World) => expect(world.calls.filter(call => /\bdelete\b/iu.test(call))).toEqual([])

describe('release body', () => {
  it('round-trips the exact authorized identity', () => {
    expect(parseReleaseBody(REPO, renderReleaseBody(REPO, IDENTITY))).toEqual(IDENTITY)
  })

  it('tolerates CRLF storage but nothing else about the image block', () => {
    expect(parseReleaseBody(REPO, renderReleaseBody(REPO, IDENTITY).replaceAll('\n', '\r\n'))).toEqual(IDENTITY)
    const body = renderReleaseBody(REPO, IDENTITY)
    expect(parseReleaseBody(REPO, body.replace(`Source: ${SOURCE}`, 'Source: nothex'))).toBeNull()
    expect(parseReleaseBody(REPO, body.replace(`${IMAGE}:${VERSION}`, `${IMAGE}:latest`))).toBeNull()
    expect(parseReleaseBody(REPO, 'just notes, no image block')).toBeNull()
  })

  it('reads the legacy image block', () => {
    const legacy = `generated\n\n## Image\n\nImage: ${IMAGE}:2026.11.2\nDigest: ${IMAGE}@${PREDECESSOR.digest}\nSource: ${'d'.repeat(40)}`
    expect(parseReleaseBody(REPO, legacy)).toEqual({version: '2026.11.2', source: 'd'.repeat(40), digest: PREDECESSOR.digest, notes: 'generated'})
  })
})

describe('publishRelease: real driver through fixed commands', () => {
  it('publishes the exact tuple in order, verifies latest and offers deploy once to a fresh attempt 1', async () => {
    const world = new World()
    const outcome = await publishRelease(input(), world.run, 1)
    expect(outcome).toEqual({kind: 'complete', identity: IDENTITY, deploy: 'eligible'})
    expect(world.writes).toEqual(['create-draft', 'create-tag', `alias:${VERSION}`, `alias:${SHA_ALIAS}`, 'publish', 'alias:latest'])
    expect(world.refs.get(VERSION)).toBe(SOURCE)
    expect(world.images.get(VERSION)).toBe(DIGEST)
    expect(world.images.get(SHA_ALIAS)).toBe(DIGEST)
    expect(world.images.get('latest')).toBe(DIGEST)
    expect(world.published.map(r => r.tag)).toEqual([VERSION])
    expect(world.published[0]?.body).toBe(renderReleaseBody(REPO, IDENTITY))
    noDestructive(world)
  })

  it('passes the verified workflow attempt: a rerun converges but is never offered a deploy', async () => {
    const world = new World()
    expect(await publishRelease(input(), world.run, 2)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
  })

  it('resumes an interrupted publication without a duplicate or a deploy offer', async () => {
    const world = new World()
    world.draft()
    world.refs.set(VERSION, SOURCE)
    world.images.set(VERSION, DIGEST)
    const outcome = await publishRelease(input(), world.run, 1)
    expect(outcome).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
    expect(world.writes).toEqual([`alias:${SHA_ALIAS}`, 'publish', 'alias:latest'])
    expect(world.releases.size).toBe(1)
  })

  it('treats a post-publication state as complete without writing', async () => {
    const world = new World()
    const release = world.draft()
    release.draft = false
    world.refs.set(VERSION, SOURCE)
    for (const name of [VERSION, SHA_ALIAS, 'latest']) world.images.set(name, DIGEST)
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
    expect(world.writes).toEqual([])
  })

  it.each(['create-draft', 'create-tag', `alias:${VERSION}`, `alias:${SHA_ALIAS}`, 'publish', 'alias:latest'] as Op[])('re-observes a lost response after %s and converges', async op => {
    const world = new World()
    world.lost.add(op)
    const outcome = await publishRelease(input(), world.run, 1)
    expect(outcome).toEqual({kind: 'complete', identity: IDENTITY, deploy: 'eligible'})
    expect(world.writes.filter(write => write === op)).toHaveLength(1)
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
    noDestructive(world)
  })

  it('stops, unconfirmed and without cleanup, when a write is genuinely not applied', async () => {
    const world = new World()
    world.dropped.add('create-tag')
    const outcome = await publishRelease(input(), world.run, 1)
    expect(outcome).toEqual({kind: 'stop', reason: 'write-unconfirmed', detail: 'create-tag'})
    expect(world.releases.size).toBe(1)
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
    noDestructive(world)
  })
})

describe('publishRelease: definitive absence versus unknown', () => {
  it('treats only a documented not-found as absence', async () => {
    const world = new World() // tag 404, aliases not found: both definitive
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'complete'})
  })

  it.each([
    ['releases', 'releases-unreadable'],
    ['tag', 'tag-unreadable'],
    ['tag-404', 'tag-unreadable'],
    ['tag-empty', 'tag-unreadable'],
    [`image:${VERSION}`, 'alias-unreadable'],
    [`image:${SHA_ALIAS}`, 'alias-unreadable'],
    ['image:latest', 'latest-unreadable'],
  ])('stops on an ambiguous %s read and never writes', async (key, reason) => {
    const world = new World()
    world.unreadable.add(key)
    const outcome = await publishRelease(input(), world.run, 1)
    expect(outcome).toMatchObject({kind: 'stop', reason})
    expect(world.writes).toEqual([])
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
  })

  it('stops on a malformed release list', async () => {
    const world = new World()
    const run: Runner = async (command, args) => (args.includes('--slurp') ? ok(JSON.stringify([[{id: 'x', tag_name: 5}]])) : world.run(command, args))
    expect(await publishRelease(input(), run, 1)).toMatchObject({kind: 'stop', reason: 'releases-unreadable'})
    expect(world.writes).toEqual([])
  })

  it('does not infer absence of latest', async () => {
    const world = new World()
    world.images.delete('latest')
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'stop', reason: 'latest-unproven'})
    expect(world.writes).toEqual([])
  })

  it('does not publish when the draft was written for a different image', async () => {
    const world = new World()
    world.draft(renderReleaseBody(REPO, {...IDENTITY, digest: `sha256:${'9'.repeat(64)}`}))
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'stop', reason: 'evidence-mismatch'})
    expect(world.writes).toEqual([])
  })
})

describe('publishRelease: conflicts write nothing and delete nothing', () => {
  it.each([
    ['tag at another commit', (w: World) => w.refs.set(VERSION, 'e'.repeat(40)), 'tag-conflict'],
    ['version alias at another digest', (w: World) => w.images.set(VERSION, `sha256:${'8'.repeat(64)}`), 'alias-conflict'],
    ['sha alias at another digest', (w: World) => w.images.set(SHA_ALIAS, `sha256:${'8'.repeat(64)}`), 'alias-conflict'],
    ['latest at an unrelated digest', (w: World) => w.images.set('latest', `sha256:${'8'.repeat(64)}`), 'latest-conflict'],
    ['a rival draft', (w: World) => w.draft(renderReleaseBody(REPO, {...IDENTITY, version: '2026.11.4', source: 'c'.repeat(40)}), '2026.11.4'), 'other-unresolved'],
    ['edited notes', (w: World) => w.draft(renderReleaseBody(REPO, {...IDENTITY, notes: 'edited by hand'})), 'notes-mismatch'],
  ] as const)('%s', async (_name, arrange, reason) => {
    const world = new World()
    arrange(world)
    const outcome = await publishRelease(input(), world.run, 1)
    expect(outcome).toMatchObject({kind: 'stop', reason})
    expect(world.writes).toEqual([])
    noDestructive(world)
  })
})

describe('publishRelease: publish-only boundary', () => {
  it('refuses to allocate', async () => {
    const world = new World()
    const outcome = await publishRelease(input({builds: {state: 'present', value: []}, evidence: {state: 'present', value: []}}), world.run, 1)
    expect(outcome).toEqual({kind: 'stop', reason: 'allocate-refused'})
    expect(world.calls.filter(call => call.startsWith('gh api --method'))).toEqual([])
  })

  it('refuses to build or gate', async () => {
    const world = new World()
    expect(await publishRelease(input({evidence: {state: 'present', value: []}}), world.run, 1)).toEqual({kind: 'stop', reason: 'handoff-refused', detail: 'gate'})
    const rebuild = input({builds: {state: 'present', value: [{...BUILD, digest: null}]}, evidence: {state: 'present', value: []}})
    expect(await publishRelease(rebuild, new World().run, 1)).toEqual({kind: 'stop', reason: 'handoff-refused', detail: 'build'})
    expect(world.writes).toEqual([])
  })

  it('stops on unverified controller facts rather than inferring verification', async () => {
    const world = new World()
    const unverified = input({evidence: {state: 'present', value: [{...EVIDENCE, verified: false}]}})
    expect(await publishRelease(unverified, world.run, 1)).toMatchObject({kind: 'stop', reason: 'unverified-record'})
    expect(world.writes).toEqual([])
  })

  it('stops when the controller could not supply gate facts', async () => {
    const world = new World()
    const unknown = input({evidence: {state: 'unknown', reason: 'read-failed'}})
    expect(await publishRelease(unknown, world.run, 1)).toMatchObject({kind: 'stop', reason: 'evidence-unreadable'})
    expect(world.writes).toEqual([])
  })
})

describe('createPublicationPorts: no write outside the authorized tuple', () => {
  const ports = (world: World) => createPublicationPorts(input(), world.run)

  it.each([
    ['draft for another source', {kind: 'create-draft', identity: {...IDENTITY, source: 'c'.repeat(40)}}],
    ['draft with edited notes', {kind: 'create-draft', identity: {...IDENTITY, notes: 'other'}}],
    ['draft for a digest that never passed', {kind: 'create-draft', identity: {...IDENTITY, digest: `sha256:${'7'.repeat(64)}`}}],
    ['tag at another commit', {kind: 'create-tag', version: VERSION, source: 'c'.repeat(40)}],
    ['tag with a malformed version', {kind: 'create-tag', version: 'latest', source: SOURCE}],
    ['version alias under another name', {kind: 'create-alias', alias: 'version', name: '2026.11.9', digest: DIGEST}],
    ['sha alias under another name', {kind: 'create-alias', alias: 'sha', name: 'sha-bbbbbbb', digest: DIGEST}],
    ['alias for a digest that never passed', {kind: 'create-alias', alias: 'sha', name: SHA_ALIAS, digest: `sha256:${'7'.repeat(64)}`}],
    ['latest for a digest that never passed', {kind: 'set-latest', digest: `sha256:${'7'.repeat(64)}`}],
    ['allocation', {kind: 'allocate'}],
  ] as const)('refuses %s before any command', async (_name, action) => {
    const world = new World()
    await expect(ports(world).apply(action)).rejects.toThrow()
    expect(world.calls).toEqual([])
  })

  it('publishes by release id after a fresh read of that exact draft', async () => {
    const world = new World()
    const release = world.draft()
    await ports(world).apply({kind: 'publish-release', version: VERSION})
    expect(world.calls.filter(call => call.includes('--method PATCH'))).toEqual([`gh api --method PATCH repos/${REPO}/releases/${release.id} -F draft=false`])
  })

  it('does not publish when the fresh read by id no longer matches the listed draft', async () => {
    const world = new World()
    const release = world.draft()
    const changed = renderReleaseBody(REPO, {...IDENTITY, notes: 'changed after listing'})
    const run: Runner = async (command, args) =>
      args.length === 2 && args.at(-1) === `repos/${REPO}/releases/${release.id}`
        ? ok(JSON.stringify({id: release.id, tag_name: VERSION, draft: true, body: changed}))
        : world.run(command, args)
    await expect(createPublicationPorts(input(), run).apply({kind: 'publish-release', version: VERSION})).rejects.toThrow()
    expect(world.writes).toEqual([])
  })

  it.each([
    ['two drafts for the version', (w: World) => [w.draft(), w.draft()]],
    ['no draft', () => {}],
    ['a draft for another digest', (w: World) => { w.draft(renderReleaseBody(REPO, {...IDENTITY, digest: `sha256:${'9'.repeat(64)}`})) }],
    ['a draft that is already public', (w: World) => { w.draft().draft = false }],
    ['an unreadable draft', (w: World) => { w.unreadable.add(`release:${w.draft().id}`) }],
  ] as const)('does not publish %s', async (_name, arrange) => {
    const world = new World()
    arrange(world)
    await expect(ports(world).apply({kind: 'publish-release', version: VERSION})).rejects.toThrow()
    expect(world.writes).toEqual([])
  })
})

describe('parsePublishInput', () => {
  const valid = () => JSON.parse(JSON.stringify(input())) as Record<string, unknown>

  it('accepts a complete typed controller input', () => {
    expect(parsePublishInput(valid())).toEqual(input())
  })

  it.each([
    ['missing source', (v: Record<string, unknown>) => { delete v.source }],
    ['non-hex source', (v: Record<string, unknown>) => { v.source = 'main' }],
    ['non-string notes', (v: Record<string, unknown>) => { v.notes = null }],
    ['bad repo', (v: Record<string, unknown>) => { v.repo = 'fro-bot/dashboard/../x' }],
    ['bad predecessor digest', (v: Record<string, unknown>) => { v.predecessor = {version: '2026.11.2', digest: 'latest'} }],
    ['verified given as a string', (v: Record<string, unknown>) => { v.evidence = {state: 'present', value: [{...EVIDENCE, verified: 'true'}]} }],
    ['build without run id', (v: Record<string, unknown>) => { v.builds = {state: 'present', value: [{...BUILD, runId: undefined}]} }],
    ['unknown state', (v: Record<string, unknown>) => { v.builds = {state: 'maybe'} }],
    ['caller-supplied dispatch', (v: Record<string, unknown>) => { v.dispatch = 'accepted' }],
  ])('rejects %s', (_name, mutate) => {
    const value = valid()
    mutate(value)
    expect(parsePublishInput(value)).toBeNull()
  })
})

describe('runPublisherCli', () => {
  const deps = (world: World, payload: unknown = input()) => {
    const out: string[] = []
    return {out, deps: {run: world.run, readFile: () => JSON.stringify(payload), write: (text: string) => out.push(text)}}
  }

  it('prints a single JSON outcome and exits 0 on completion', async () => {
    const world = new World()
    const {out, deps: d} = deps(world)
    expect(await runPublisherCli(['input.json'], {GITHUB_RUN_ATTEMPT: '1'}, d)).toBe(0)
    expect(JSON.parse(out.join(''))).toEqual({kind: 'complete', version: VERSION, source: SOURCE, digest: DIGEST, deploy: 'eligible'})
  })

  it('exits 1 with a stable reason on a stop, without raw errors', async () => {
    const world = new World()
    world.unreadable.add('releases')
    const {out, deps: d} = deps(world)
    expect(await runPublisherCli(['input.json'], {GITHUB_RUN_ATTEMPT: '1'}, d)).toBe(1)
    expect(JSON.parse(out.join(''))).toEqual({kind: 'stop', reason: 'releases-unreadable', detail: 'read-failed'})
    expect(out.join('')).not.toContain(SECRET)
  })

  it.each([
    ['no attempt', ['input.json'], {}],
    ['zero attempt', ['input.json'], {GITHUB_RUN_ATTEMPT: '0'}],
    ['non-numeric attempt', ['input.json'], {GITHUB_RUN_ATTEMPT: '1; rm'}],
    ['no input path', [], {GITHUB_RUN_ATTEMPT: '1'}],
    ['extra arguments', ['input.json', '--version', '9'], {GITHUB_RUN_ATTEMPT: '1'}],
  ])('exits 2 before any command on %s', async (_name, argv, env) => {
    const world = new World()
    const {deps: d} = deps(world)
    expect(await runPublisherCli(argv, env, d)).toBe(2)
    expect(world.calls).toEqual([])
  })

  it('exits 2 before any command on an invalid input file', async () => {
    const world = new World()
    const {deps: d} = deps(world, {source: 'main'})
    expect(await runPublisherCli(['input.json'], {GITHUB_RUN_ATTEMPT: '1'}, d)).toBe(2)
    expect(world.calls).toEqual([])
  })
})

describe('tag read: documented matching-refs list, never a bare 404', () => {
  const REF = `refs/tags/${VERSION}`
  const respondWith = (world: World, stdout: string): Runner => async (command, args) => (args.at(-1)?.includes('/git/matching-refs/') === true ? ok(stdout) : world.run(command, args))

  it('does not use the single-ref endpoint', async () => {
    const world = new World()
    await publishRelease(input(), world.run, 1)
    expect(world.calls.filter(call => call.includes('/git/ref/'))).toEqual([])
    expect(world.calls).toContain(`gh api --paginate --slurp repos/${REPO}/git/matching-refs/tags/${VERSION}`)
  })

  it('treats an empty successful list as absence and a prefix sibling as not the tag', async () => {
    const world = new World()
    world.refs.set('2026.11.30', 'e'.repeat(40))
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'complete'})
    expect(world.refs.get(VERSION)).toBe(SOURCE)
    expect(world.refs.get('2026.11.30')).toBe('e'.repeat(40))
  })

  it('still finds a conflicting exact tag among prefix siblings', async () => {
    const world = new World()
    world.refs.set(VERSION, 'e'.repeat(40))
    world.refs.set('2026.11.30', SOURCE)
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'stop', reason: 'tag-conflict'})
    expect(world.writes).toEqual([])
  })

  it('treats a 404 as unknown because it can conceal access denial', async () => {
    const world = new World()
    world.unreadable.add('tag-404')
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'stop', reason: 'tag-unreadable'})
    expect(world.writes).toEqual([])
  })

  const good = {ref: REF, node_id: 'n', url: 'u', object: {sha: SOURCE, type: 'commit', url: 'u'}}
  it.each([
    ['not a list of pages', '{}'],
    ['a page that is not a list', JSON.stringify([good])],
    ['an annotated tag object', JSON.stringify([[{...good, object: {...good.object, type: 'tag'}}]])],
    ['a short sha', JSON.stringify([[{...good, object: {...good.object, sha: 'abc'}}]])],
    ['a missing object', JSON.stringify([[{ref: REF}]])],
    ['a duplicated exact ref', JSON.stringify([[good, good]])],
    ['a malformed prefix sibling', JSON.stringify([[{ref: 'refs/tags/2026.11.30'}, good]])],
    ['a non-JSON body', 'not json'],
  ])('stops on %s', async (_name, stdout) => {
    const world = new World()
    expect(await publishRelease(input(), respondWith(world, stdout), 1)).toMatchObject({kind: 'stop', reason: 'tag-unreadable'})
    expect(world.writes).toEqual([])
  })

  it('accepts a complete exact commit ref', async () => {
    const world = new World()
    world.draft()
    world.images.set(VERSION, DIGEST)
    world.images.set(SHA_ALIAS, DIGEST)
    const list = JSON.stringify([[{ref: 'refs/tags/2026.11.30', object: {sha: 'e'.repeat(40), type: 'commit'}}, good]])
    expect(await publishRelease(input(), respondWith(world, list), 1)).toMatchObject({kind: 'complete'})
    expect(world.writes).toEqual(['publish', 'alias:latest'])
  })
})

describe('registry absence needs the exact requested manifest', () => {
  it.each([
    ['a missing helper', 'docker: buildx: not found'],
    ['another tag of the same repository', `${IMAGE}:other: not found`],
    ['a tag that only extends the requested one', `${IMAGE}:${VERSION}0: not found`],
    ['another repository', `ghcr.io/fro-bot/other:${VERSION}: not found`],
    ['the registry host', 'ghcr.io: not found'],
    ['a manifest-unknown error that names no ref', 'ERROR: manifest unknown'],
    ['the exact ref plus an unrelated line', `warning: something\n${IMAGE}:${VERSION}: not found`],
  ])('does not take %s for absence of a present alias', async (_name, stderr) => {
    const world = new World()
    world.images.set(VERSION, DIGEST)
    world.inspectFailure.set(VERSION, stderr)
    expect(await publishRelease(input(), world.run, 1)).toEqual({kind: 'stop', reason: 'alias-unreadable', detail: 'version'})
    expect(world.writes).toEqual([])
  })

  it('does not take an unrelated not-found for an absent latest', async () => {
    const world = new World()
    world.inspectFailure.set('latest', 'ghcr.io: not found')
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'stop', reason: 'latest-unreadable'})
    expect(world.writes).toEqual([])
  })

  it('accepts the exact ref with the buildx ERROR prefix', async () => {
    const world = new World()
    world.inspectFailure.set(VERSION, `ERROR: ${IMAGE}:${VERSION}: not found`)
    world.inspectFailure.set(SHA_ALIAS, `${IMAGE}:${SHA_ALIAS}: not found\n`)
    // Writing an alias populates `images`, so lift the canned failures after the first read pass.
    const run: Runner = async (command, args) => {
      const result = await world.run(command, args)
      if (command === 'docker' && args[2] === 'create') world.inspectFailure.clear()
      return result
    }
    expect(await publishRelease(input(), run, 1)).toMatchObject({kind: 'complete'})
  })
})

describe('rival and recorded releases are never verified from body syntax', () => {
  it('reports a parsed rival publication as unresolved, not as a verified checkpoint', async () => {
    const world = new World()
    world.draft(renderReleaseBody(REPO, {...IDENTITY, version: '2026.11.4', source: 'c'.repeat(40)}), '2026.11.4').draft = false
    expect(await publishRelease(input(), world.run, 1)).toEqual({kind: 'stop', reason: 'other-unresolved', detail: '2026.11.4'})
    expect(world.writes).toEqual([])
  })

  it('marks no release record verified', async () => {
    const world = new World()
    world.draft()
    world.draft(renderReleaseBody(REPO, {...IDENTITY, version: '2026.11.4', source: 'c'.repeat(40)}), '2026.11.4').draft = false
    const {releases} = await createPublicationPorts(input(), world.run).observeRecords()
    expect(releases.state).toBe('present')
    if (releases.state === 'present') {
      expect(releases.value).toHaveLength(2)
      expect(releases.value.every(r => !r.verified && r.identity !== null)).toBe(true)
    }
  })
})

describe('createExecRunner', () => {
  type Exec = NonNullable<Parameters<typeof createExecRunner>[0]>
  const env = {GH_TOKEN: 'app-token', GITHUB_TOKEN: 'actions-token', GH_ENTERPRISE_TOKEN: 'e1', GITHUB_ENTERPRISE_TOKEN: 'e2', DOCKER_CONFIG: '/home/runner/.docker', PATH: '/usr/bin', HOME: '/home/runner'}
  const stub = (result: {code?: number | string | null; stdout?: string; stderr?: string} | null = null) => {
    const seen: {file: string; env: Record<string, string | undefined>}[] = []
    const exec: Exec = (file, _args, options, done) => {
      seen.push({file, env: options.env})
      done(result === null ? null : {code: result.code}, result?.stdout ?? 'out', result?.stderr ?? 'err')
    }
    return {seen, runner: createExecRunner(exec, env)}
  }

  it('strips gh credentials from docker but keeps its registry session config', async () => {
    const {seen, runner} = stub()
    await runner('docker', ['buildx', 'imagetools', 'inspect', 'x'])
    expect(seen[0]?.env).toEqual({DOCKER_CONFIG: '/home/runner/.docker', PATH: '/usr/bin', HOME: '/home/runner'})
  })

  it('leaves the gh environment untouched', async () => {
    const {seen, runner} = stub()
    await runner('gh', ['api', 'x'])
    expect(seen[0]?.env).toEqual(env)
  })

  it('reports exit status as a result and a spawn failure as -1', async () => {
    expect(await stub().runner('gh', [])).toEqual({status: 0, stdout: 'out', stderr: 'err'})
    expect(await stub({code: 2, stdout: '', stderr: 'bad'}).runner('gh', [])).toEqual({status: 2, stdout: '', stderr: 'bad'})
    expect(await stub({code: 'ENOENT', stdout: '', stderr: ''}).runner('docker', [])).toMatchObject({status: -1})
  })
})

describe('contradictory gate evidence cannot authorize a write', () => {
  const OTHER_DIGEST = `sha256:${'3'.repeat(64)}`
  const siblings = [
    ['failed smoke', {...EVIDENCE, runId: 101, smoke: 'fail'}],
    ['failed trivy', {...EVIDENCE, runId: 101, trivy: {enforced: true, result: 'fail'}}],
    ['unverified', {...EVIDENCE, runId: 101, verified: false}],
    ['non-enforced trivy', {...EVIDENCE, runId: 101, attempt: 2, trivy: {enforced: false, result: 'pass'}}],
  ] as const
  const actions = [
    ['create-draft', {kind: 'create-draft', identity: IDENTITY}],
    ['create-tag', {kind: 'create-tag', version: VERSION, source: SOURCE}],
    ['version alias', {kind: 'create-alias', alias: 'version', name: VERSION, digest: DIGEST}],
    ['sha alias', {kind: 'create-alias', alias: 'sha', name: SHA_ALIAS, digest: DIGEST}],
    ['set-latest', {kind: 'set-latest', digest: DIGEST}],
    ['publish-release', {kind: 'publish-release', version: VERSION}],
  ] as const
  const withEvidence = (world: World, value: Evidence[]) => createPublicationPorts(input({evidence: {state: 'present', value}}), world.run)

  describe.each(siblings)('with a %s sibling for the same version, source and digest', (_label, sibling) => {
    it.each(actions)('refuses %s before any command', async (_name, action) => {
      const world = new World()
      world.draft()
      await expect(withEvidence(world, [EVIDENCE, sibling]).apply(action)).rejects.toThrow()
      expect(world.calls).toEqual([])
      expect(world.writes).toEqual([])
    })

    it('refuses regardless of record order', async () => {
      const world = new World()
      await expect(withEvidence(world, [sibling, EVIDENCE]).apply({kind: 'set-latest', digest: DIGEST})).rejects.toThrow()
      expect(world.calls).toEqual([])
    })
  })

  it('leaves another digest of the same version and source authorized', async () => {
    const world = new World()
    const clean = {...EVIDENCE, runId: 102, digest: OTHER_DIGEST}
    const ports = withEvidence(world, [EVIDENCE, siblings[0][1], clean])
    await expect(ports.apply({kind: 'set-latest', digest: DIGEST})).rejects.toThrow()
    await ports.apply({kind: 'set-latest', digest: OTHER_DIGEST})
    expect(world.writes).toEqual(['alias:latest'])
    expect(world.images.get('latest')).toBe(OTHER_DIGEST)
  })

  it('is not contradicted by a failure for another version or source', async () => {
    const world = new World()
    const elsewhere = [{...EVIDENCE, runId: 103, version: '2026.11.9', smoke: 'fail'}, {...EVIDENCE, runId: 104, source: 'c'.repeat(40), smoke: 'fail'}] as Evidence[]
    await withEvidence(world, [EVIDENCE, ...elsewhere]).apply({kind: 'set-latest', digest: DIGEST})
    expect(world.writes).toEqual(['alias:latest'])
  })

  it('stops the real driver without any write when gate records contradict', async () => {
    const world = new World()
    const outcome = await publishRelease(input({evidence: {state: 'present', value: [EVIDENCE, siblings[0][1]]}}), world.run, 1)
    expect(outcome).toEqual({kind: 'stop', reason: 'gate-conflict'})
    expect(world.writes).toEqual([])
    expect(world.calls.filter(call => call.startsWith('gh api --method') || call.includes('imagetools create'))).toEqual([])
  })
})

describe('publishRelease: a deleted release after publication', () => {
  it('stops with release-record-missing instead of recreating the draft or offering a deploy', async () => {
    const world = new World()
    expect(await publishRelease(input(), world.run, 1)).toMatchObject({kind: 'complete', deploy: 'eligible'})
    world.releases.clear()
    const writes = world.writes.length
    expect(await publishRelease(input(), world.run, 1)).toEqual({kind: 'stop', reason: 'release-record-missing'})
    expect(world.writes).toHaveLength(writes)
    expect(world.releases.size).toBe(0)
  })

  it('stops on a retagged release body that still names this source', async () => {
    const world = new World()
    world.draft(renderReleaseBody(REPO, IDENTITY), 'v2026.11.3')
    expect(await publishRelease(input(), world.run, 1)).toEqual({kind: 'stop', reason: 'malformed-release', detail: 'v2026.11.3'})
    expect(world.writes).toEqual([])
  })
})
