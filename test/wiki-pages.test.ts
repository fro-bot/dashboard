import type {GitHubSnapshot} from '../src/wiki/data-client.ts'
import type {GateContractDecision} from '../src/wiki/gate-contract.ts'

import {GATE_CONTRACT_VERSION} from '@fro.bot/wiki-write-core'
import {describe, expect, it, vi} from 'vitest'
import {isErr, isOk} from '../src/result.ts'
import {WikiDataUnavailableError} from '../src/wiki/data-client.ts'
import {createGateContractChecker} from '../src/wiki/gate-contract.ts'
import {correctionsDigest, createWikiPages, EMPTY_CORRECTIONS_DIGEST} from '../src/wiki/pages.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INFRA = 'knowledge/wiki/repos/marcusrbrown--infra.md'
const MISE = 'knowledge/wiki/entities/mise.md'
const TOPIC = 'knowledge/wiki/topics/docker-containers.md'

function page(frontmatter: Record<string, string>, body = '\n# Body\n\nBun workspace monorepo.\n'): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

const INFRA_PAGE = page({type: 'repo', title: 'marcusrbrown/infra', updated: '2026-10-21', node_id: 'R_infra'})
const MISE_PAGE = page({type: 'entity', title: 'mise', updated: '2026-09-25'}, '\n# mise\n\nVersion manager.\n')
const TOPIC_PAGE = page({type: 'topic', title: 'Docker containers', updated: '2026-08-01', node_id: 'T_docker'})

function entry(id: string, nodeId: string, text: string, extra = ''): string {
  return `  - id: ${id}\n    page_node_id: ${nodeId}\n    span:\n      text: ${text}\n${extra}`
}

function correctionsYaml(...entries: string[]): string {
  return `version: 1\ncorrections:\n${entries.join('')}`
}

function snapshotOf(files: Record<string, string>, headSha = 'head-1'): GitHubSnapshot {
  const fileShas = Object.fromEntries(Object.keys(files).map(path => [path, `blob-of:${path}`]))
  return {headSha, treeSha: 'tree-1', files, fileShas}
}

const BASE_FILES = {
  [INFRA]: INFRA_PAGE,
  [MISE]: MISE_PAGE,
  [TOPIC]: TOPIC_PAGE,
  'knowledge/index.md': '# index\n',
  'knowledge/wiki/README.md': '# readme\n',
  'knowledge/wiki/entities/.gitkeep': '',
  '.github/workflows/merge-data.yaml': 'name: x\n',
}

const OK_DECISION: GateContractDecision = {
  proceed: true,
  marker: {version: GATE_CONTRACT_VERSION, sourceTreeHash: 's'},
  readiness: {ready: true, stale: false, mainHeadSha: 'main-1'},
}

function makePages(files: Record<string, string>, overrides: {decision?: GateContractDecision | (() => Promise<never>)} = {}) {
  const getSnapshot = vi.fn(async () => snapshotOf(files))
  const checkContract = vi.fn(async () => {
    const decision = overrides.decision ?? OK_DECISION
    return typeof decision === 'function' ? decision() : decision
  })
  return {pages: createWikiPages({client: {getSnapshot}, checkContract}), getSnapshot, checkContract}
}

const WRITABLE = {canWrite: true} as const

async function readOk(files: Record<string, string>, id: string, access = WRITABLE as Parameters<ReturnType<typeof makePages>['pages']['readPage']>[1]) {
  const result = await makePages(files).pages.readPage(id, access)
  if (!isOk(result)) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.data
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('wiki page list', () => {
  it('returns every allowlisted page with type, title, updated, and mark capability', async () => {
    const result = await makePages(BASE_FILES).pages.listPages()

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data.headSha).toBe('head-1')
    expect(result.data.pages).toEqual([
      {id: 'repos.marcusrbrown--infra', title: 'marcusrbrown/infra', type: 'repos', updated: '2026-10-21', canMark: true},
      {id: 'topics.docker-containers', title: 'Docker containers', type: 'topics', updated: '2026-08-01', canMark: true},
      {id: 'entities.mise', title: 'mise', type: 'entities', updated: '2026-09-25', canMark: false},
    ])
  })

  it('leaves out files that are not allowlisted pages', async () => {
    const result = await makePages({
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(),
      'knowledge/wiki/repos/nested/a.md': page({title: 'nested'}),
      'knowledge/wiki/other/a.md': page({title: 'other'}),
      'knowledge/wiki/repos/not-markdown.txt': 'x',
    }).pages.listPages()

    expect(isOk(result) && result.data.pages.map(p => p.id)).toEqual([
      'repos.marcusrbrown--infra',
      'topics.docker-containers',
      'entities.mise',
    ])
  })

  it('orders pages by directory order and then by ID, deterministically', async () => {
    const files = {
      'knowledge/wiki/topics/b.md': page({title: 'B'}),
      'knowledge/wiki/repos/z.md': page({title: 'Z'}),
      'knowledge/wiki/topics/a.md': page({title: 'A'}),
      'knowledge/wiki/comparisons/c.md': page({title: 'C'}),
      'knowledge/wiki/entities/e.md': page({title: 'E'}),
      'knowledge/wiki/repos/y.md': page({title: 'Y'}),
    }

    const result = await makePages(files).pages.listPages()

    expect(isOk(result) && result.data.pages.map(p => p.id)).toEqual([
      'repos.y',
      'repos.z',
      'topics.a',
      'topics.b',
      'entities.e',
      'comparisons.c',
    ])
  })

  it('lists a page with unparseable frontmatter under its file name, unable to carry marks', async () => {
    const result = await makePages({'knowledge/wiki/topics/broken.md': 'no frontmatter at all\n'}).pages.listPages()

    expect(isOk(result) && result.data.pages).toEqual([
      {id: 'topics.broken', title: 'broken', type: 'topics', updated: null, canMark: false},
    ])
  })

  it('falls back to the file name for a missing or non-string title, and null for a missing updated', async () => {
    const result = await makePages({
      'knowledge/wiki/topics/untitled.md': '---\ntype: topic\ntitle:\n  - not\n  - a string\n---\nbody\n',
    }).pages.listPages()

    expect(isOk(result) && result.data.pages[0]).toMatchObject({title: 'untitled', updated: null})
  })

  it('treats an empty or non-string node_id as unable to carry marks', async () => {
    const result = await makePages({
      'knowledge/wiki/topics/a.md': '---\ntitle: A\nnode_id: ""\n---\nbody\n',
      'knowledge/wiki/topics/b.md': '---\ntitle: B\nnode_id: 42\n---\nbody\n',
    }).pages.listPages()

    expect(isOk(result) && result.data.pages.map(p => p.canMark)).toEqual([false, false])
  })

  it('returns an empty list for a wiki with no pages', async () => {
    const result = await makePages({'knowledge/index.md': '# index\n'}).pages.listPages()

    expect(isOk(result) && result.data.pages).toEqual([])
  })

  it('never returns a partial list when the snapshot is unavailable', async () => {
    const getSnapshot = vi.fn().mockRejectedValue(new WikiDataUnavailableError('tree-truncated', null))
    const pages = createWikiPages({client: {getSnapshot}, checkContract: async () => OK_DECISION})

    const result = await pages.listPages()

    expect(isErr(result) && result.error).toEqual({kind: 'unavailable', status: null})
  })
})

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

describe('wiki page read model', () => {
  it('strips frontmatter and returns the page blob SHA, identity, and head SHA', async () => {
    const model = await readOk(BASE_FILES, 'repos.marcusrbrown--infra')

    expect(model).toMatchObject({
      id: 'repos.marcusrbrown--infra',
      type: 'repos',
      title: 'marcusrbrown/infra',
      updated: '2026-10-21',
      body: '\n# Body\n\nBun workspace monorepo.\n',
      pageBlobSha: `blob-of:${INFRA}`,
      nodeId: 'R_infra',
      canMark: true,
      headSha: 'head-1',
    })
    expect(model.body).not.toContain('node_id')
    expect(model.body).not.toContain('---')
  })

  it('reports a page without node_id as unable to carry marks', async () => {
    const model = await readOk(BASE_FILES, 'entities.mise')

    expect(model.nodeId).toBeNull()
    expect(model.canMark).toBe(false)
    expect(model.corrections).toEqual([])
    expect(model.correctionsBase).toBe(EMPTY_CORRECTIONS_DIGEST)
  })

  it('returns the corrections entries and digest for this page only', async () => {
    const files = {
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(
        entry('c1', 'R_infra', 'Bun workspace monorepo'),
        entry('c2', 'T_docker', 'Docker containers'),
        entry('c3', 'R_infra', 'Bun', '    state: retired\n'),
      ),
    }

    const infra = await readOk(files, 'repos.marcusrbrown--infra')
    const topic = await readOk(files, 'topics.docker-containers')

    expect(infra.corrections.map(c => [c.id, c.status])).toEqual([
      ['c1', 'active'],
      ['c3', 'retired'],
    ])
    expect(topic.corrections.map(c => c.id)).toEqual(['c2'])
    expect(infra.correctionsBase).toBe(correctionsDigest(infra.corrections.map(c => c.record)))
    expect(infra.correctionsBase).not.toBe(topic.correctionsBase)
  })

  it('carries span, attribution, reason, and lifecycle status on each entry', async () => {
    const files = {
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(
        entry(
          'c1',
          'R_infra',
          'Bun workspace monorepo',
          '    attribution:\n      actor: marcusrbrown\n      recorded_at: "2030-01-01T00:00:00Z"\n    state: needs-reconfirmation\n    reason: formatting drift\n',
        ),
      ),
    }

    const model = await readOk(files, 'repos.marcusrbrown--infra')

    expect(model.corrections).toHaveLength(1)
    expect(model.corrections[0]).toMatchObject({
      id: 'c1',
      status: 'needs-reconfirmation',
      span: {text: 'Bun workspace monorepo'},
      attribution: {actor: 'marcusrbrown', recordedAt: '2030-01-01T00:00:00Z'},
      reason: 'formatting drift',
      stale: false,
    })
  })

  it.each(['retired', 'active'])('treats a reason on a %s entry as a corrupt file, so no stray reason is shown', async state => {
    const files = {
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(
        entry(
          'c1',
          'R_infra',
          'Bun workspace monorepo',
          `    attribution:\n      actor: marcusrbrown\n      recorded_at: "2030-01-01T00:00:00Z"\n    state: ${state}\n    reason: leftover text\n`,
        ),
      ),
    }

    const result = await makePages(files).pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    expect(result).toMatchObject({success: false, error: {kind: 'corrections-corrupt'}})
  })

  it('treats a missing corrections file as an empty set with the empty digest', async () => {
    const model = await readOk(BASE_FILES, 'repos.marcusrbrown--infra')

    expect(model.corrections).toEqual([])
    expect(model.correctionsBase).toBe(EMPTY_CORRECTIONS_DIGEST)
    expect(model.correctionsBase).toBe(correctionsDigest([]))
  })

  it('gives an empty set of this page the same digest as a missing file', async () => {
    const files = {...BASE_FILES, 'knowledge/corrections.yaml': correctionsYaml(entry('c9', 'T_docker', 'x'))}

    const model = await readOk(files, 'repos.marcusrbrown--infra')

    expect(model.correctionsBase).toBe(EMPTY_CORRECTIONS_DIGEST)
  })

  it('flags an active correction whose span is no longer in the page', async () => {
    const files = {
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(
        entry('present', 'R_infra', 'Bun workspace monorepo'),
        entry('eroded', 'R_infra', 'text that is gone from the page'),
        entry('retired-gone', 'R_infra', 'also gone', '    state: retired\n'),
      ),
    }

    const model = await readOk(files, 'repos.marcusrbrown--infra')

    expect(Object.fromEntries(model.corrections.map(c => [c.id, c.stale]))).toEqual({
      present: false,
      eroded: true,
      'retired-gone': false,
    })
  })

  it.each([
    ['an empty file', ''],
    ['a whitespace-only file', '  \n\n'],
    ['invalid YAML', 'version: 1\ncorrections: [\n'],
    ['a wrong version', 'version: 2\ncorrections: []\n'],
    ['a non-array corrections field', 'version: 1\ncorrections: nope\n'],
    ['an invalid entry', 'version: 1\ncorrections:\n  - id: c1\n'],
  ])('reports %s as corrupt, never as an empty list', async (_label, content) => {
    const result = await makePages({...BASE_FILES, 'knowledge/corrections.yaml': content}).pages.readPage(
      'repos.marcusrbrown--infra',
      WRITABLE,
    )

    expect(isErr(result) && result.error).toEqual({kind: 'corrections-corrupt'})
  })

  it('does not echo corrupt corrections content in the error', async () => {
    const result = await makePages({...BASE_FILES, 'knowledge/corrections.yaml': 'version: 2 # secret-note\n'}).pages.readPage(
      'repos.marcusrbrown--infra',
      WRITABLE,
    )

    expect(JSON.stringify(result)).not.toContain('secret-note')
  })

  it('passes canWrite and its reason through to the model', async () => {
    const denied = await readOk(BASE_FILES, 'repos.marcusrbrown--infra', {canWrite: false, reason: 'not-operator'})

    expect(denied.canWrite).toBe(false)
    expect(denied.canWriteReason).toBe('not-operator')

    const allowed = await readOk(BASE_FILES, 'repos.marcusrbrown--infra', WRITABLE)
    expect(allowed.canWrite).toBe(true)
    expect(allowed.canWriteReason).toBeNull()
  })

  it.each(['', 'repos', '../etc/passwd', 'repos.a/b', 'repos.a%2Fb', 'repos..', 'unknown.x'])(
    'rejects the page ID %j before any network call',
    async id => {
      const {pages, getSnapshot, checkContract} = makePages(BASE_FILES)

      const result = await pages.readPage(id, WRITABLE)

      expect(isErr(result) && result.error).toEqual({kind: 'invalid-id'})
      expect(getSnapshot).not.toHaveBeenCalled()
      expect(checkContract).not.toHaveBeenCalled()
    },
  )

  it('reports a well-formed ID that is not in the tree as not found', async () => {
    const result = await makePages(BASE_FILES).pages.readPage('repos.no-such-page', WRITABLE)

    expect(isErr(result) && result.error).toEqual({kind: 'not-found'})
  })

  it('reports a page with unparseable frontmatter as invalid, not as an empty page', async () => {
    const result = await makePages({'knowledge/wiki/topics/broken.md': 'nothing here\n'}).pages.readPage(
      'topics.broken',
      WRITABLE,
    )

    expect(isErr(result) && result.error).toEqual({kind: 'page-invalid'})
  })

  it('maps a snapshot failure to unavailable with the status', async () => {
    const getSnapshot = vi.fn().mockRejectedValue(new WikiDataUnavailableError('read-failed', 503))
    const pages = createWikiPages({client: {getSnapshot}, checkContract: async () => OK_DECISION})

    const result = await pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    expect(isErr(result) && result.error).toEqual({kind: 'unavailable', status: 503})
  })

  it('maps any unexpected snapshot throw to unavailable instead of throwing', async () => {
    const getSnapshot = vi.fn().mockRejectedValue(new TypeError('boom'))
    const pages = createWikiPages({client: {getSnapshot}, checkContract: async () => OK_DECISION})

    const result = await pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    expect(isErr(result) && result.error).toEqual({kind: 'unavailable', status: null})
  })
})

// ---------------------------------------------------------------------------
// Contract state
// ---------------------------------------------------------------------------

describe('wiki page read model: contract state', () => {
  it('reports ok when the gate contract matches', async () => {
    const model = await readOk(BASE_FILES, 'repos.marcusrbrown--infra')

    expect(model.contract).toEqual({ok: true})
  })

  it('reports a version mismatch as a no-retry state', async () => {
    const decision: GateContractDecision = {
      proceed: false,
      reason: 'version_mismatch',
      marker: {version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 's'},
      readiness: {ready: false, stale: false, mainHeadSha: 'main-1'},
    }
    const result = await makePages(BASE_FILES, {decision}).pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    expect(isOk(result) && result.data.contract).toEqual({ok: false, kind: 'mismatch', retry: false})
  })

  it('reports an unreadable marker as a retryable state', async () => {
    const decision: GateContractDecision = {
      proceed: false,
      reason: 'unavailable',
      readiness: {ready: false, stale: true, mainHeadSha: null},
    }
    const result = await makePages(BASE_FILES, {decision}).pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    expect(isOk(result) && result.data.contract).toEqual({ok: false, kind: 'unreadable', retry: true})
  })

  it('treats a throwing contract check as unreadable and still returns the page', async () => {
    const decision = async (): Promise<never> => {
      throw new Error('checker blew up')
    }
    const result = await makePages(BASE_FILES, {decision}).pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    expect(isOk(result) && result.data.contract).toEqual({ok: false, kind: 'unreadable', retry: true})
  })
})

// ---------------------------------------------------------------------------
// Corrections digest
// ---------------------------------------------------------------------------

describe('correctionsDigest', () => {
  const a = {id: 'c1', page_node_id: 'R_infra', span: {text: 'one'}}
  const b = {id: 'c2', page_node_id: 'R_infra', span: {text: 'two'}, state: 'retired'}

  it('is stable under entry order', () => {
    expect(correctionsDigest([a, b])).toBe(correctionsDigest([b, a]))
  })

  it('is stable under object key order', () => {
    const reordered = {span: {text: 'one'}, page_node_id: 'R_infra', id: 'c1'}

    expect(correctionsDigest([reordered, b])).toBe(correctionsDigest([a, b]))
  })

  it.each([
    ['an id', {...a, id: 'c1x'}],
    ['a span text', {...a, span: {text: 'changed'}}],
    ['a state', {...a, state: 'retired'}],
    ['an extra field', {...a, reason: 'why'}],
  ])('changes when %s changes', (_label, changed) => {
    expect(correctionsDigest([changed, b])).not.toBe(correctionsDigest([a, b]))
  })

  it('changes when an entry is added or removed', () => {
    expect(correctionsDigest([a])).not.toBe(correctionsDigest([a, b]))
    expect(correctionsDigest([a])).not.toBe(EMPTY_CORRECTIONS_DIGEST)
  })

  it('does not collide when text moves across entry boundaries', () => {
    const left = [{id: 'c1', page_node_id: 'n', span: {text: 'a\n'}}, {id: 'c2', page_node_id: 'n', span: {text: 'b'}}]
    const right = [{id: 'c1', page_node_id: 'n', span: {text: 'a'}}, {id: 'c2', page_node_id: 'n', span: {text: '\nb'}}]

    expect(correctionsDigest(left)).not.toBe(correctionsDigest(right))
  })

  it('is a lowercase hex SHA-256', () => {
    expect(EMPTY_CORRECTIONS_DIGEST).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('does not change when another page entry is present in the file', async () => {
    const withOther = {
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(entry('c1', 'R_infra', 'Bun workspace monorepo'), entry('c2', 'T_docker', 'x')),
    }
    const without = {
      ...BASE_FILES,
      'knowledge/corrections.yaml': correctionsYaml(entry('c1', 'R_infra', 'Bun workspace monorepo')),
    }

    const one = await readOk(withOther, 'repos.marcusrbrown--infra')
    const two = await readOk(without, 'repos.marcusrbrown--infra')

    expect(one.correctionsBase).toBe(two.correctionsBase)
  })

  it('is stable when the file lists the same entries in a different order', async () => {
    const e1 = entry('c1', 'R_infra', 'Bun workspace monorepo')
    const e2 = entry('c2', 'R_infra', 'Bun')

    const forward = await readOk({...BASE_FILES, 'knowledge/corrections.yaml': correctionsYaml(e1, e2)}, 'repos.marcusrbrown--infra')
    const backward = await readOk({...BASE_FILES, 'knowledge/corrections.yaml': correctionsYaml(e2, e1)}, 'repos.marcusrbrown--infra')

    expect(forward.correctionsBase).toBe(backward.correctionsBase)
  })
})

describe('page reads during a gate-contract outage with no cached marker', () => {
  it('answers unreadable with retry on every read and fetches the marker once inside the failure window', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
    let now = 0
    const checker = createGateContractChecker({fetch, now: () => now})
    const pages = createWikiPages({
      client: {getSnapshot: vi.fn(async () => snapshotOf(BASE_FILES))},
      checkContract: async () => checker.check(),
    })

    const reads = await Promise.all([
      pages.readPage('repos.marcusrbrown--infra', WRITABLE),
      pages.readPage('repos.marcusrbrown--infra', WRITABLE),
    ])
    now += 5000
    const later = await pages.readPage('repos.marcusrbrown--infra', WRITABLE)

    for (const result of [...reads, later]) {
      if (!isOk(result)) throw new Error('expected ok')
      expect(result.data.contract).toEqual({ok: false, kind: 'unreadable', retry: true})
    }
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
