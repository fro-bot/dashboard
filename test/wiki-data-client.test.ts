import {Buffer} from 'node:buffer'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {logger} from '../src/logger.ts'
import {
  createBlobCache,
  createReadTransport,
  createWikiDataClient,
  createWriteTransport,
  isRefusal,
  rateLimitOf,
  readTokenSource,
  RequestNotSentError,
  WikiDataUnavailableError,
  writeTokenSource,
} from '../src/wiki/data-client.ts'
import {SNAPSHOT_PATH_PREFIXES} from '../src/wiki/paths.ts'

function blobResponse(text: string): {data: {content: string; encoding: string}} {
  return {data: {content: Buffer.from(text).toString('base64'), encoding: 'base64'}}
}

function readTransport(
  entries: {path: string; type: string; sha: string}[],
  blobs: Record<string, string>,
  options: {head?: string; truncated?: boolean} = {},
) {
  return {
    getRef: vi.fn().mockResolvedValue({data: {object: {sha: options.head ?? 'head-1'}}}),
    getCommit: vi.fn().mockResolvedValue({
      data: {sha: options.head ?? 'head-1', tree: {sha: 'tree-1'}, message: '', parents: []},
    }),
    getTree: vi.fn().mockResolvedValue({data: {tree: entries, truncated: options.truncated ?? false}}),
    getBlob: vi.fn(async (params: Record<string, unknown>) => blobResponse(blobs[params.file_sha as string] ?? '')),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('wiki data client: snapshot', () => {
  it('reads a tree snapshot and decodes only blob files', async () => {
    const transport = readTransport(
      [
        {path: 'knowledge/wiki/topics/example.md', type: 'blob', sha: 'blob-1'},
        {path: 'ignored', type: 'tree', sha: 'tree-2'},
      ],
      {'blob-1': '# Example\n'},
    )
    const client = createWikiDataClient(transport)

    await expect(client.getSnapshot()).resolves.toMatchObject({
      headSha: 'head-1',
      treeSha: 'tree-1',
      files: {'knowledge/wiki/topics/example.md': '# Example\n'},
      fileShas: {'knowledge/wiki/topics/example.md': 'blob-1'},
    })
    expect(transport.getBlob).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', file_sha: 'blob-1'})
    expect(transport.getBlob).toHaveBeenCalledTimes(1)
  })

  it('requests the full recursive tree for the data ref', async () => {
    const transport = readTransport([], {})

    await createWikiDataClient(transport).getSnapshot()

    expect(transport.getRef).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', ref: 'heads/data'})
    expect(transport.getTree).toHaveBeenCalledWith({
      owner: 'fro-bot',
      repo: '.github',
      tree_sha: 'tree-1',
      recursive: '1',
    })
  })

  it('bounds concurrent blob reads while batching a tree snapshot', async () => {
    let active = 0
    let maximum = 0
    const entries = Array.from({length: 16}, (_, index) => ({
      path: `knowledge/wiki/topics/${index}.md`,
      type: 'blob',
      sha: `blob-${index}`,
    }))
    const transport = {
      ...readTransport(entries, {}),
      getBlob: vi.fn(async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise(resolve => setTimeout(resolve, 1))
        active -= 1
        return blobResponse('# Example\n')
      }),
    }

    await createWikiDataClient(transport).getSnapshot()

    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(8)
  })

  it('keeps a file named like an Object prototype key as an own property', async () => {
    const transport = readTransport([{path: 'knowledge/__proto__', type: 'blob', sha: 'blob-p'}], {'blob-p': 'x'})

    const snapshot = await createWikiDataClient(transport).getSnapshot()

    expect(Object.keys(snapshot.files)).toEqual(['knowledge/__proto__'])
    expect(Object.getPrototypeOf(snapshot.files)).toBe(Object.prototype)
  })

  it('fails closed on a truncated tree without reading any blob', async () => {
    const transport = readTransport([{path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'blob-1'}], {}, {truncated: true})

    const failure = await createWikiDataClient(transport)
      .getSnapshot()
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(WikiDataUnavailableError)
    expect((failure as WikiDataUnavailableError).reason).toBe('tree-truncated')
    expect(transport.getBlob).not.toHaveBeenCalled()
  })

  it('treats a tree response without a tree array as unavailable, not as an empty wiki', async () => {
    const transport = {...readTransport([], {}), getTree: vi.fn().mockResolvedValue({data: {}})}

    await expect(createWikiDataClient(transport).getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
  })

  it.each([
    ['ref', 'getRef'],
    ['commit', 'getCommit'],
    ['tree', 'getTree'],
    ['blob', 'getBlob'],
  ] as const)('reports a %s read failure as a typed unavailable error with the status', async (_label, method) => {
    const transport = readTransport(
      [
        {path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'blob-1'},
        {path: 'knowledge/wiki/topics/b.md', type: 'blob', sha: 'blob-2'},
      ],
      {'blob-1': 'a', 'blob-2': 'b'},
    )
    const leaky = Object.assign(new Error('boom ghs_abcdefghijklmnopqrstuvwxyz0123456789'), {status: 502})
    transport[method] = vi.fn().mockRejectedValue(leaky) as never

    const failure = await createWikiDataClient(transport)
      .getSnapshot()
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(WikiDataUnavailableError)
    const error = failure as WikiDataUnavailableError
    expect(error.reason).toBe('read-failed')
    expect(error.status).toBe(502)
    expect(error.message).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(error.cause).toBeUndefined()
  })

  it('never returns a partial snapshot when one blob read fails', async () => {
    const entries = Array.from({length: 12}, (_, index) => ({
      path: `knowledge/wiki/topics/${index}.md`,
      type: 'blob',
      sha: `blob-${index}`,
    }))
    const transport = {
      ...readTransport(entries, {}),
      getBlob: vi.fn(async (params: Record<string, unknown>) => {
        if (params.file_sha === 'blob-5') throw new Error('nope')
        return blobResponse('ok')
      }),
    }

    await expect(createWikiDataClient(transport).getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
  })

  it('reports an invalid blob encoding as unavailable', async () => {
    const transport = {
      ...readTransport([{path: 'knowledge/a.md', type: 'blob', sha: 'blob-1'}], {}),
      getBlob: vi.fn().mockResolvedValue({data: {content: 'x', encoding: 'utf-8'}}),
    }

    await expect(createWikiDataClient(transport).getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
  })

  it('reports a missing transport method as unavailable', async () => {
    await expect(createWikiDataClient({}).getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
  })
})

describe('wiki data client: narrowed snapshot', () => {
  const IN_SET = [
    'knowledge/wiki/repos/marcusrbrown--infra.md',
    'knowledge/wiki/topics/docker-containers.md',
    'knowledge/wiki/entities/mise.md',
    'knowledge/wiki/comparisons/a-vs-b.md',
    'knowledge/index.md',
    'knowledge/log.md',
    'knowledge/corrections.yaml',
    'knowledge/schema.md',
    'metadata/repos.yaml',
  ]
  const OUT_OF_SET = [
    '.github/workflows/merge-data.yaml',
    'docs/plans/2026-01-01-001-feat-x-plan.md',
    'README.md',
    'assets/banner.svg',
    'metadata/repos.yaml.bak',
    'metadata/other.yaml',
    'knowledgebase/x.md',
    'src/knowledge/x.md',
  ]
  const tree = [...IN_SET, ...OUT_OF_SET].map((path, index) => ({path, type: 'blob', sha: `blob-${index}`}))
  const blobs = Object.fromEntries(tree.map(entry => [entry.sha, `content of ${entry.path}`]))

  it('pins the prefix list that bounds snapshot blob reads', () => {
    expect([...SNAPSHOT_PATH_PREFIXES]).toEqual(['knowledge/', 'metadata/repos.yaml'])
  })

  it('reads every wiki page, the knowledge root files, and the metadata file', async () => {
    const snapshot = await createWikiDataClient(readTransport(tree, blobs)).getSnapshot()

    expect(Object.keys(snapshot.files).sort()).toEqual([...IN_SET].sort())
    expect(Object.keys(snapshot.fileShas).sort()).toEqual([...IN_SET].sort())
  })

  it('excludes workflow files, docs, and every other path, and never fetches their blobs', async () => {
    const transport = readTransport(tree, blobs)

    const snapshot = await createWikiDataClient(transport).getSnapshot()

    for (const path of OUT_OF_SET) expect(snapshot.files).not.toHaveProperty(path)
    expect(transport.getBlob).toHaveBeenCalledTimes(IN_SET.length)
    const fetched = transport.getBlob.mock.calls.map(([params]) => params.file_sha)
    for (const entry of tree.filter(item => OUT_OF_SET.includes(item.path))) expect(fetched).not.toContain(entry.sha)
  })

  it('still requests the full recursive tree, and keeps the full tree SHA', async () => {
    const transport = readTransport(tree, blobs)

    const snapshot = await createWikiDataClient(transport).getSnapshot()

    expect(transport.getTree).toHaveBeenCalledTimes(1)
    expect(transport.getTree).toHaveBeenCalledWith(expect.objectContaining({tree_sha: 'tree-1', recursive: '1'}))
    expect(snapshot.treeSha).toBe('tree-1')
  })

  it('keeps every untouched file: a commit built on the snapshot tree names only changed paths', async () => {
    const transport = {
      ...readTransport(tree, blobs),
      createBlob: vi.fn().mockResolvedValue({data: {sha: 'blob-new'}}),
      createTree: vi.fn().mockResolvedValue({data: {sha: 'tree-2'}}),
    }
    const client = createWikiDataClient(transport)
    const snapshot = await client.getSnapshot()

    const changedPath = 'knowledge/wiki/topics/docker-containers.md'
    const blob = await client.createBlob('edited')
    await client.createTree(snapshot.treeSha, [{path: changedPath, sha: blob}])

    const params = transport.createTree.mock.calls[0]?.[0] as {base_tree: string; tree: {path: string; sha: string | null}[]}
    expect(params.base_tree).toBe('tree-1')
    expect(params.tree).toEqual([{path: changedPath, mode: '100644', type: 'blob', sha: 'blob-new'}])
    expect(params.tree.some(entry => entry.sha === null)).toBe(false)
    for (const path of OUT_OF_SET) expect(params.tree.map(entry => entry.path)).not.toContain(path)
  })
})

describe('wiki data client: blob cache', () => {
  const entries = [
    {path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'blob-a'},
    {path: 'knowledge/wiki/topics/b.md', type: 'blob', sha: 'blob-b'},
  ]

  it('makes no blob fetch when an unchanged blob is read a second time', async () => {
    const transport = readTransport(entries, {'blob-a': 'A', 'blob-b': 'B'})
    const client = createWikiDataClient(transport)

    const first = await client.getSnapshot()
    expect(transport.getBlob).toHaveBeenCalledTimes(2)
    const second = await client.getSnapshot()

    expect(transport.getBlob).toHaveBeenCalledTimes(2)
    expect(second.files).toEqual(first.files)
  })

  it('refetches only the changed blob after the head moves', async () => {
    const transport = readTransport(entries, {'blob-a': 'A', 'blob-b': 'B'})
    const client = createWikiDataClient(transport)
    await client.getSnapshot()
    transport.getBlob.mockClear()

    transport.getRef.mockResolvedValue({data: {object: {sha: 'head-2'}}})
    transport.getTree.mockResolvedValue({
      data: {
        tree: [
          {path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'blob-a'},
          {path: 'knowledge/wiki/topics/b.md', type: 'blob', sha: 'blob-b2'},
        ],
      },
    })
    transport.getBlob.mockImplementation(async (params: Record<string, unknown>) =>
      blobResponse(params.file_sha === 'blob-b2' ? 'B2' : 'A'),
    )
    const snapshot = await client.getSnapshot()

    expect(transport.getBlob).toHaveBeenCalledTimes(1)
    expect(transport.getBlob).toHaveBeenCalledWith(expect.objectContaining({file_sha: 'blob-b2'}))
    expect(snapshot.files['knowledge/wiki/topics/b.md']).toBe('B2')
    expect(snapshot.files['knowledge/wiki/topics/a.md']).toBe('A')
  })

  it('fetches a blob once when two paths share its SHA', async () => {
    const transport = readTransport(
      [
        {path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'same'},
        {path: 'knowledge/wiki/topics/b.md', type: 'blob', sha: 'same'},
      ],
      {same: 'S'},
    )

    const snapshot = await createWikiDataClient(transport).getSnapshot()

    expect(transport.getBlob).toHaveBeenCalledTimes(1)
    expect(snapshot.files).toEqual({'knowledge/wiki/topics/a.md': 'S', 'knowledge/wiki/topics/b.md': 'S'})
  })

  it('shares a cache between clients when one is passed in', async () => {
    const blobCache = createBlobCache({maxBytes: 1024})
    const one = readTransport(entries, {'blob-a': 'A', 'blob-b': 'B'})
    const two = readTransport(entries, {'blob-a': 'A', 'blob-b': 'B'})

    await createWikiDataClient(one, {blobCache}).getSnapshot()
    await createWikiDataClient(two, {blobCache}).getSnapshot()

    expect(two.getBlob).not.toHaveBeenCalled()
  })

  it('does not cache a failed fetch', async () => {
    const transport = readTransport([entries[0] as (typeof entries)[number]], {'blob-a': 'A'})
    const client = createWikiDataClient(transport)
    transport.getBlob.mockRejectedValueOnce(new Error('transient'))

    await expect(client.getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
    const snapshot = await client.getSnapshot()

    expect(snapshot.files['knowledge/wiki/topics/a.md']).toBe('A')
  })

  describe('createBlobCache', () => {
    it('stores and returns content by blob SHA', () => {
      const cache = createBlobCache({maxBytes: 100})

      cache.set('sha-1', 'hello')

      expect(cache.get('sha-1')).toBe('hello')
      expect(cache.get('sha-2')).toBeUndefined()
      expect(cache.sizeBytes()).toBe(5)
    })

    it('counts bytes, not characters', () => {
      const cache = createBlobCache({maxBytes: 100})

      cache.set('sha-1', '\u00E9\u00E9')

      expect(cache.sizeBytes()).toBe(4)
    })

    it('evicts the least recently used entries to stay within the byte bound', () => {
      const cache = createBlobCache({maxBytes: 10})
      cache.set('a', '1234')
      cache.set('b', '1234')
      cache.get('a')
      cache.set('c', '1234')

      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('a')).toBe('1234')
      expect(cache.get('c')).toBe('1234')
      expect(cache.sizeBytes()).toBeLessThanOrEqual(10)
    })

    it('does not store a blob larger than the whole bound', () => {
      const cache = createBlobCache({maxBytes: 4})
      cache.set('small', 'ab')
      cache.set('big', 'abcdefgh')

      expect(cache.get('big')).toBeUndefined()
      expect(cache.get('small')).toBe('ab')
    })

    it('replaces an existing entry without double counting', () => {
      const cache = createBlobCache({maxBytes: 100})
      cache.set('a', '1234')
      cache.set('a', '12')

      expect(cache.sizeBytes()).toBe(2)
    })

    it('rejects a non-positive bound', () => {
      expect(() => createBlobCache({maxBytes: 0})).toThrow(/maxBytes/)
      expect(() => createBlobCache({maxBytes: Number.NaN})).toThrow(/maxBytes/)
    })

    it('does not log or print blob content', async () => {
      const spies = [
        vi.spyOn(logger, 'debug'),
        vi.spyOn(logger, 'info'),
        vi.spyOn(logger, 'warning'),
        vi.spyOn(logger, 'error'),
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'warn'),
        vi.spyOn(console, 'error'),
      ]
      const transport = readTransport(entries, {'blob-a': 'secret-body-a', 'blob-b': 'secret-body-b'})
      const client = createWikiDataClient(transport, {blobCache: createBlobCache({maxBytes: 8})})

      await client.getSnapshot()
      await client.getSnapshot()

      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
  })
})

describe('wiki data client: writes and history', () => {
  it('uses a non-forced ref update and supplies the observed parent to the commit', async () => {
    const transport = {
      createBlob: vi.fn().mockResolvedValue({data: {sha: 'blob-2'}}),
      createTree: vi.fn().mockResolvedValue({data: {sha: 'tree-2'}}),
      createCommit: vi.fn().mockResolvedValue({data: {sha: 'commit-2'}}),
      updateRef: vi.fn().mockResolvedValue({data: {}}),
    }
    const client = createWikiDataClient(transport)

    const blob = await client.createBlob('# Example\n')
    const tree = await client.createTree('tree-1', [{path: 'knowledge/wiki/topics/example.md', sha: blob}])
    await client.createCommit({treeSha: tree, parentSha: 'head-1', message: 'docs: edit\n\nFro-Operation-Id: op-1'})
    await client.updateRef('commit-2')

    expect(transport.createCommit).toHaveBeenCalledWith(expect.objectContaining({parents: ['head-1']}))
    expect(transport.updateRef).toHaveBeenCalledWith({
      owner: 'fro-bot',
      repo: '.github',
      ref: 'heads/data',
      sha: 'commit-2',
      force: false,
    })
  })

  it('lists commits touching one allowlisted path on the data ref since a time', async () => {
    const transport = {
      listCommitsByPath: vi.fn().mockResolvedValue({
        data: [
          {
            sha: 'c2',
            commit: {message: 'edit\n\nFro-Operation-Id: op-1', tree: {sha: 't2'}, committer: {date: '2030-01-02T00:00:00Z'}},
            parents: [{sha: 'c1'}],
          },
          {sha: 'c1', commit: {message: 'older'}, parents: []},
        ],
      }),
    }
    const client = createWikiDataClient(transport)

    const commits = await client.listCommitsByPath('knowledge/wiki/topics/a.md', {since: '2030-01-01T00:00:00Z'})

    expect(transport.listCommitsByPath).toHaveBeenCalledWith({
      owner: 'fro-bot',
      repo: '.github',
      sha: 'data',
      path: 'knowledge/wiki/topics/a.md',
      since: '2030-01-01T00:00:00Z',
      per_page: 100,
    })
    expect(commits).toEqual([
      {
        sha: 'c2',
        message: 'edit\n\nFro-Operation-Id: op-1',
        parents: ['c1'],
        treeSha: 't2',
        committedAt: '2030-01-02T00:00:00Z',
      },
      {sha: 'c1', message: 'older', parents: []},
    ])
  })

  it('omits since when none is given', async () => {
    const transport = {listCommitsByPath: vi.fn().mockResolvedValue({data: []})}

    await createWikiDataClient(transport).listCommitsByPath('knowledge/corrections.yaml')

    expect(transport.listCommitsByPath.mock.calls[0]?.[0]).not.toHaveProperty('since')
  })

  it('rejects a history query for a path outside the allowlist before any request', async () => {
    const transport = {listCommitsByPath: vi.fn()}

    await expect(createWikiDataClient(transport).listCommitsByPath('.github/workflows/merge-data.yaml')).rejects.toThrow(
      'path',
    )
    expect(transport.listCommitsByPath).not.toHaveBeenCalled()
  })

  it('sends the promote-data dispatch with no payload', async () => {
    const transport = {createDispatch: vi.fn().mockResolvedValue({data: {}})}

    await createWikiDataClient(transport).createPromotionDispatch()

    expect(transport.createDispatch).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', event_type: 'promote-data'})
  })

  it('lists open pull requests from data into main', async () => {
    const transport = {
      listPulls: vi.fn().mockResolvedValue({
        data: [{number: 7, html_url: 'https://github.com/fro-bot/.github/pull/7', created_at: '2030-01-01T00:00:00Z', extra: 1}],
      }),
    }

    const pulls = await createWikiDataClient(transport).listPromotionPulls()

    expect(transport.listPulls).toHaveBeenCalledWith({
      owner: 'fro-bot',
      repo: '.github',
      state: 'open',
      head: 'fro-bot:data',
      base: 'main',
      per_page: 10,
    })
    expect(pulls).toEqual([{number: 7, url: 'https://github.com/fro-bot/.github/pull/7', createdAt: '2030-01-01T00:00:00Z'}])
  })

  it('reads the newest merge-data run, or null when there is none', async () => {
    const run = {
      id: 99,
      status: 'completed',
      conclusion: 'failure',
      event: 'schedule',
      created_at: '2030-01-01T00:00:00Z',
      html_url: 'https://github.com/fro-bot/.github/actions/runs/99',
    }
    const transport = {listWorkflowRuns: vi.fn().mockResolvedValue({data: {workflow_runs: [run]}})}
    const client = createWikiDataClient(transport)

    await expect(client.getLatestPromotionRun()).resolves.toEqual({
      id: 99,
      status: 'completed',
      conclusion: 'failure',
      event: 'schedule',
      createdAt: '2030-01-01T00:00:00Z',
      url: 'https://github.com/fro-bot/.github/actions/runs/99',
    })
    expect(transport.listWorkflowRuns).toHaveBeenCalledWith({
      owner: 'fro-bot',
      repo: '.github',
      workflow_id: 'merge-data.yaml',
      per_page: 1,
    })

    transport.listWorkflowRuns.mockResolvedValue({data: {workflow_runs: []}})
    await expect(client.getLatestPromotionRun()).resolves.toBeNull()
  })

  it('lists the jobs and steps of a run', async () => {
    const transport = {
      listRunJobs: vi.fn().mockResolvedValue({
        data: {
          jobs: [
            {
              name: 'merge',
              conclusion: 'failure',
              steps: [
                {name: 'checkout', conclusion: 'success', number: 1},
                {name: '\uD83D\uDD12 Block private wiki pages', conclusion: 'failure', number: 2},
              ],
            },
          ],
        },
      }),
    }

    const jobs = await createWikiDataClient(transport).listRunJobs(99)

    expect(transport.listRunJobs).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', run_id: 99, per_page: 100})
    expect(jobs).toEqual([
      {
        name: 'merge',
        conclusion: 'failure',
        steps: [
          {name: 'checkout', conclusion: 'success'},
          {name: '\uD83D\uDD12 Block private wiki pages', conclusion: 'failure'},
        ],
      },
    ])
  })

  it.each([
    ['pulls', async (c: ReturnType<typeof createWikiDataClient>) => c.listPromotionPulls(), {listPulls: vi.fn().mockResolvedValue({data: {}})}],
    [
      'runs',
      async (c: ReturnType<typeof createWikiDataClient>) => c.getLatestPromotionRun(),
      {listWorkflowRuns: vi.fn().mockResolvedValue({data: {}})},
    ],
    ['jobs', async (c: ReturnType<typeof createWikiDataClient>) => c.listRunJobs(1), {listRunJobs: vi.fn().mockResolvedValue({data: {}})}],
  ])('rejects a malformed %s response', async (_label, call, transport) => {
    await expect(call(createWikiDataClient(transport))).rejects.toThrow()
  })
})

describe('wiki data client: write support', () => {
  it('reads the head SHA with one request', async () => {
    const transport = readTransport([], {}, {head: 'head-9'})

    await expect(createWikiDataClient(transport).getHeadSha()).resolves.toBe('head-9')
    expect(transport.getRef).toHaveBeenCalledTimes(1)
    expect(transport.getTree).not.toHaveBeenCalled()
  })

  it('returns the commit SHA and the time GitHub reports for a created commit', async () => {
    const transport = {
      createCommit: vi.fn().mockResolvedValue({data: {sha: 'c1', committer: {date: '2030-01-02T03:04:05Z'}}}),
    }

    await expect(
      createWikiDataClient(transport).createCommit({treeSha: 't', parentSha: 'p', message: 'm'}),
    ).resolves.toEqual({sha: 'c1', committedAt: '2030-01-02T03:04:05Z'})
  })

  it('sends the given author and committer, and sends none when none are given', async () => {
    const transport = {createCommit: vi.fn().mockResolvedValue({data: {sha: 'c1'}})}
    const client = createWikiDataClient(transport)
    const identity = {name: 'fro-bot[bot]', email: '109017866+fro-bot[bot]@users.noreply.github.com'}

    await client.createCommit({treeSha: 't', parentSha: 'p', message: 'm', author: identity, committer: identity})
    await client.createCommit({treeSha: 't', parentSha: 'p', message: 'm'})

    expect(transport.createCommit.mock.calls[0]?.[0]).toMatchObject({author: identity, committer: identity})
    expect(transport.createCommit.mock.calls[1]?.[0]).not.toHaveProperty('author')
    expect(transport.createCommit.mock.calls[1]?.[0]).not.toHaveProperty('committer')
  })

  it('refuses to create a tree entry outside the write allowlist, or one that deletes', async () => {
    const transport = {createTree: vi.fn().mockResolvedValue({data: {sha: 't2'}})}
    const client = createWikiDataClient(transport)

    await expect(client.createTree('t1', [{path: '.github/workflows/merge-data.yaml', sha: 'b'}])).rejects.toThrow('path')
    await expect(client.createTree('t1', [{path: 'knowledge/wiki/topics/a.md', sha: null}])).rejects.toThrow('delete')
    expect(transport.createTree).not.toHaveBeenCalled()
    await expect(client.createTree('t1', [{path: 'knowledge/log.md', sha: 'b'}])).resolves.toBe('t2')
  })

  it('carries the commit time on listed commits', async () => {
    const transport = {
      listCommitsByPath: vi.fn().mockResolvedValue({
        data: [{sha: 'c1', commit: {message: 'm', committer: {date: '2030-01-01T00:00:00Z'}}, parents: []}],
      }),
    }

    const [commit] = await createWikiDataClient(transport).listCommitsByPath('knowledge/corrections.yaml')

    expect(commit?.committedAt).toBe('2030-01-01T00:00:00Z')
  })

  it('reports a rate-limited snapshot read with its retry hint', async () => {
    const limited = Object.assign(new Error('API rate limit exceeded'), {status: 403, response: {headers: {'retry-after': '12'}}})
    const transport = {...readTransport([], {}), getRef: vi.fn().mockRejectedValue(limited)}

    const failure = await createWikiDataClient(transport)
      .getSnapshot()
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(WikiDataUnavailableError)
    expect((failure as WikiDataUnavailableError).rateLimit).toEqual({retryAfterSeconds: 12})
  })

  describe('rateLimitOf', () => {
    const error = (status: number | undefined, message: string, headers?: Record<string, string>) =>
      Object.assign(new Error(message), {status, ...(headers === undefined ? {} : {response: {headers}})})

    it.each([
      ['a 429', error(429, 'Too Many Requests', {'retry-after': '5'}), {retryAfterSeconds: 5}],
      ['a 403 with no remaining quota', error(403, 'Forbidden', {'x-ratelimit-remaining': '0'}), {retryAfterSeconds: null}],
      ['a 403 that names a rate limit', error(403, 'You have exceeded a secondary rate limit'), {retryAfterSeconds: null}],
      ['a 429 with no headers', error(429, 'Too Many Requests'), {retryAfterSeconds: null}],
    ])('recognises %s', (_label, input, expected) => {
      expect(rateLimitOf(input)).toEqual(expected)
    })

    it.each([
      ['an ordinary 403', error(403, 'Resource not accessible by integration')],
      ['a 404', error(404, 'Not Found')],
      ['a 500', error(500, 'Server Error')],
      ['a plain Error', new Error('nope')],
      ['a non-error', 'x'],
      ['null', null],
    ])('ignores %s', (_label, input) => {
      expect(rateLimitOf(input)).toBeNull()
    })

    it('ignores a nonsense retry-after value', () => {
      expect(rateLimitOf(error(429, 'x', {'retry-after': 'soon'}))).toEqual({retryAfterSeconds: null})
      expect(rateLimitOf(error(429, 'x', {'retry-after': '-4'}))).toEqual({retryAfterSeconds: null})
    })
  })
})

/** The rejection of a promise that is expected to fail. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

function unauthorizedThenOk(statuses: number[]) {
  const seen: {authorization: string | null}[] = []
  const impl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')
    seen.push({authorization})
    const status = statuses[seen.length - 1] ?? 200
    return new Response(JSON.stringify(status === 200 ? {object: {sha: 'head-1'}} : {message: 'Bad credentials'}), {
      status,
      headers: {'content-type': 'application/json'},
    })
  })
  return {impl: impl as unknown as typeof fetch, seen}
}

function source(tokens: string[], invalidate?: (token: string) => void) {
  let index = 0
  const getToken = vi.fn(async () => tokens[Math.min(index++, tokens.length - 1)] ?? 'none')
  return {getToken, source: writeTokenSource(getToken, invalidate)}
}

describe('wiki data client: transports', () => {
  interface Seen {
    readonly url: string
    readonly method: string
    readonly authorization: string | null
    readonly body: unknown
  }

  function fakeFetch(handler: (seen: Seen) => unknown) {
    const seen: Seen[] = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const entry: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      }
      seen.push(entry)
      return new Response(JSON.stringify(handler(entry)), {status: 200, headers: {'content-type': 'application/json'}})
    })
    return {fetch, seen}
  }

  const repoHandler = (request: Seen): unknown => {
    const seen = {...request, url: decodeURIComponent(request.url)}
    if (seen.url.includes('/git/ref/heads/data')) return {object: {sha: 'head-1'}}
    if (seen.url.includes('/git/commits/head-1')) return {sha: 'head-1', tree: {sha: 'tree-1'}, message: '', parents: []}
    if (seen.url.includes('/git/trees/tree-1')) return {tree: [{path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'blob-1'}]}
    if (seen.url.includes('/git/blobs/blob-1')) return {content: Buffer.from('A').toString('base64'), encoding: 'base64'}
    return {}
  }

  it('reads a snapshot through the read transport with the read token only', async () => {
    const {fetch, seen} = fakeFetch(repoHandler)
    const transport = createReadTransport(
      readTokenSource(async () => 'read-token-1'),
      {fetch},
    )

    const snapshot = await createWikiDataClient(transport).getSnapshot()

    expect(snapshot.files['knowledge/wiki/topics/a.md']).toBe('A')
    expect(seen.length).toBe(4)
    expect(seen.every(entry => entry.url.startsWith('https://api.github.com/repos/fro-bot/.github/'))).toBe(true)
    expect(seen.every(entry => entry.authorization?.includes('read-token-1'))).toBe(true)
  })

  describe('token acquisition shares the request bound', () => {
    const NEVER = async (): Promise<string> => new Promise<string>(() => {})

    it('rejects a read whose token source never resolves, within the timeout', async () => {
      const {fetch, seen} = fakeFetch(repoHandler)
      const transport = createReadTransport(readTokenSource(NEVER), {fetch, timeoutMs: 40})
      const started = Date.now()

      await expect(createWikiDataClient(transport).getSnapshot()).rejects.toThrow()

      expect(Date.now() - started).toBeLessThan(2000)
      expect(seen).toHaveLength(0)
    })

    it('rejects a save-path write and a status read whose token source never resolves', async () => {
      const {fetch, seen} = fakeFetch(() => ({}))
      const client = createWikiDataClient(createWriteTransport(writeTokenSource(NEVER), {fetch, timeoutMs: 40}))
      const started = Date.now()

      await expect(client.getHeadSha()).rejects.toThrow()
      await expect(client.createCommit({treeSha: 't', parentSha: 'p', message: 'm'})).rejects.toThrow()
      await expect(client.getLatestPromotionRun()).rejects.toThrow()
      await expect(client.listPromotionPulls()).rejects.toThrow()

      expect(Date.now() - started).toBeLessThan(3000)
      expect(seen).toHaveLength(0)
    })

    it('surfaces a slow token source as a read failure the snapshot classifies as unavailable', async () => {
      const {fetch} = fakeFetch(repoHandler)
      const transport = createReadTransport(readTokenSource(NEVER), {fetch, timeoutMs: 40})

      await expect(createWikiDataClient(transport).getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
    })

    describe('a 401 on a write-path request', () => {
      it('evicts the token, mints again, and retries the request once with the new token', async () => {
        const net = unauthorizedThenOk([401, 200])
        const invalidate = vi.fn()
        const tokens = source(['stale-token', 'fresh-token'], invalidate)
        const client = createWikiDataClient(createWriteTransport(tokens.source, {fetch: net.impl}))

        await expect(client.getHeadSha()).resolves.toBe('head-1')

        expect(invalidate).toHaveBeenCalledExactlyOnceWith('stale-token')
        expect(tokens.getToken).toHaveBeenCalledTimes(2)
        expect(net.seen.map(entry => entry.authorization)).toEqual(['token stale-token', 'token fresh-token'])
      })

      it('surfaces a second 401 as the refusal, after exactly one retry', async () => {
        const net = unauthorizedThenOk([401, 401, 200])
        const invalidate = vi.fn()
        const tokens = source(['stale-token', 'fresh-token'], invalidate)
        const client = createWikiDataClient(createWriteTransport(tokens.source, {fetch: net.impl}))

        const error = await rejectionOf(client.getHeadSha())

        expect((error as {status?: number}).status).toBe(401)
        expect(isRefusal(error)).toBe(true)
        expect(net.seen).toHaveLength(2)
        expect(invalidate).toHaveBeenCalledTimes(1)
        expect(tokens.getToken).toHaveBeenCalledTimes(2)
      })

      it.each([403, 404, 422, 500])('does not evict or retry on a %d', async status => {
        const net = unauthorizedThenOk([status])
        const invalidate = vi.fn()
        const tokens = source(['token-1', 'token-2'], invalidate)
        const client = createWikiDataClient(createWriteTransport(tokens.source, {fetch: net.impl}))

        const error = await rejectionOf(client.getHeadSha())

        expect((error as {status?: number}).status).toBe(status)
        expect(net.seen).toHaveLength(1)
        expect(invalidate).not.toHaveBeenCalled()
        expect(tokens.getToken).toHaveBeenCalledTimes(1)
      })

      it('does not retry when the source cannot refresh', async () => {
        const net = unauthorizedThenOk([401])
        const tokens = source(['token-1', 'token-2'])
        const client = createWikiDataClient(createWriteTransport(tokens.source, {fetch: net.impl}))

        const error = await rejectionOf(client.getHeadSha())

        expect((error as {status?: number}).status).toBe(401)
        expect(net.seen).toHaveLength(1)
        expect(tokens.getToken).toHaveBeenCalledTimes(1)
      })

      it('never retries a read transport, which has no refresh', async () => {
        const net = unauthorizedThenOk([401])
        const getToken = vi.fn(async () => 'read-token')
        const client = createWikiDataClient(createReadTransport(readTokenSource(getToken), {fetch: net.impl}))

        const error = await rejectionOf(client.getHeadSha())

        expect((error as {status?: number}).status).toBe(401)
        expect(net.seen).toHaveLength(1)
        expect(getToken).toHaveBeenCalledTimes(1)
      })

      it('retries a write request too, since a 401 means nothing was processed', async () => {
        const net = unauthorizedThenOk([401, 200])
        const tokens = source(['stale-token', 'fresh-token'], vi.fn())
        const client = createWikiDataClient(createWriteTransport(tokens.source, {fetch: net.impl}))

        await client.createPromotionDispatch()

        expect(net.seen.map(entry => entry.authorization)).toEqual(['token stale-token', 'token fresh-token'])
      })

      it('reports a failed re-mint as never sent, inside the same bound', async () => {
        const net = unauthorizedThenOk([401, 200])
        let calls = 0
        const getToken = vi.fn(async () => {
          calls += 1
          return calls === 1 ? 'stale-token' : new Promise<string>(() => {})
        })
        const client = createWikiDataClient(
          createWriteTransport(writeTokenSource(getToken, vi.fn()), {fetch: net.impl, timeoutMs: 60}),
        )
        const started = Date.now()

        const error = await rejectionOf(client.getHeadSha())

        expect(error).toBeInstanceOf(RequestNotSentError)
        expect(Date.now() - started).toBeLessThan(2000)
        expect(net.seen).toHaveLength(1)
      })

      it('shares one deadline across the first request and the retry', async () => {
        let calls = 0
        const impl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          calls += 1
          const first = calls === 1
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => {
                resolve(new Response('{}', {status: first ? 401 : 200, headers: {'content-type': 'application/json'}}))
              },
              first ? 120 : 10_000,
            )
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new Error('The operation was aborted due to timeout'))
            })
          })
        })
        const tokens = source(['stale-token', 'fresh-token'], vi.fn())
        const client = createWikiDataClient(
          createWriteTransport(tokens.source, {fetch: impl as unknown as typeof fetch, timeoutMs: 200}),
        )
        const started = Date.now()

        await rejectionOf(client.getHeadSha())

        // 120 ms for the first request leaves under 100 ms for the retry, not a fresh 200 ms.
        expect(Date.now() - started).toBeLessThan(290)
        expect(impl).toHaveBeenCalledTimes(2)
      })
    })

    it('marks a token timeout as never sent, and sends no request', async () => {
      const {fetch, seen} = fakeFetch(() => ({}))
      const client = createWikiDataClient(createWriteTransport(writeTokenSource(NEVER), {fetch, timeoutMs: 40}))

      const error = await rejectionOf(client.updateRef('commit-2'))

      expect(error).toBeInstanceOf(RequestNotSentError)
      expect(seen).toHaveLength(0)
    })

    it.each([
      ['a thrown error', async () => Promise.reject(new Error('Token mint returned an unexpected response')), null],
      ['a refused mint', async () => Promise.reject(Object.assign(new Error('refused'), {status: 403})), 403],
      ['a failed lookup', async () => Promise.reject(Object.assign(new Error('missing'), {status: 404})), 404],
    ])('marks %s from the token source as never sent, keeping its status', async (_label, getToken, status) => {
      const {fetch, seen} = fakeFetch(() => ({}))
      const client = createWikiDataClient(createWriteTransport(writeTokenSource(getToken), {fetch}))

      const error = await rejectionOf(client.updateRef('commit-2'))

      expect(error).toBeInstanceOf(RequestNotSentError)
      expect((error as RequestNotSentError).status).toBe(status)
      expect(seen).toHaveLength(0)
    })

    it('does not mark a failure after the request was sent as never sent', async () => {
      const hang = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')))
        }),
      )
      const client = createWikiDataClient(
        createWriteTransport(writeTokenSource(async () => 'token'), {fetch: hang, timeoutMs: 40}),
      )

      const error = await rejectionOf(client.updateRef('commit-2'))

      expect(hang).toHaveBeenCalled()
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(RequestNotSentError)
    })

    it('does not echo a token or key in the never-sent message', async () => {
      const client = createWikiDataClient(
        createWriteTransport(writeTokenSource(async () => Promise.reject(new Error('boom ghs_abcdefghijklmnopqrstuvwxyz0123456789'))), {}),
      )

      const error = await rejectionOf(client.updateRef('commit-2'))

      expect((error as Error).message).not.toContain('ghs_')
    })

    it('still passes a token that resolves inside the bound', async () => {
      const {fetch, seen} = fakeFetch(repoHandler)
      const slow = async (): Promise<string> => new Promise(resolve => setTimeout(() => resolve('late-token'), 10))
      const transport = createReadTransport(readTokenSource(slow), {fetch, timeoutMs: 1000})

      await createWikiDataClient(transport).getSnapshot()

      expect(seen.every(entry => entry.authorization?.includes('late-token'))).toBe(true)
    })

    it('does not leave a timer behind after a prompt token', async () => {
      const {fetch} = fakeFetch(repoHandler)
      const transport = createReadTransport(readTokenSource(async () => 't'), {fetch, timeoutMs: 60_000})
      vi.useFakeTimers()
      try {
        const pending = createWikiDataClient(transport).getSnapshot()
        await vi.advanceTimersByTimeAsync(0)
        await pending
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('exposes no write or status methods on the read transport', () => {
    const transport = createReadTransport(readTokenSource(async () => 't'), {fetch: fakeFetch(() => ({})).fetch})

    expect(Object.keys(transport).sort()).toEqual(['getBlob', 'getCommit', 'getRef', 'getTree'])
  })

  it('sends writes, history, dispatch, and status reads through the write transport with the write token', async () => {
    const {fetch, seen} = fakeFetch(() => ({}))
    const transport = createWriteTransport(
      writeTokenSource(async () => 'write-token-1'),
      {fetch},
    )
    const client = createWikiDataClient(transport)

    await client.updateRef('commit-2').catch(() => {})
    await client.createPromotionDispatch().catch(() => {})
    await client.listCommitsByPath('knowledge/wiki/topics/a.md').catch(() => {})
    await client.listPromotionPulls().catch(() => {})
    await client.getLatestPromotionRun().catch(() => {})
    await client.listRunJobs(5).catch(() => {})

    expect(seen.map(entry => `${entry.method} ${decodeURIComponent(new URL(entry.url).pathname)}`)).toEqual([
      'PATCH /repos/fro-bot/.github/git/refs/heads/data',
      'POST /repos/fro-bot/.github/dispatches',
      'GET /repos/fro-bot/.github/commits',
      'GET /repos/fro-bot/.github/pulls',
      'GET /repos/fro-bot/.github/actions/workflows/merge-data.yaml/runs',
      'GET /repos/fro-bot/.github/actions/runs/5/jobs',
    ])
    expect(seen.every(entry => entry.authorization?.includes('write-token-1'))).toBe(true)
    expect(seen[0]?.body).toEqual({sha: 'commit-2', force: false})
    expect(seen[1]?.body).toEqual({event_type: 'promote-data'})
  })

  it('asks the token source for a token on each request, so a rotated token is used', async () => {
    const {fetch, seen} = fakeFetch(repoHandler)
    const tokens = ['t-1', 't-2', 't-3', 't-4']
    const transport = createReadTransport(
      readTokenSource(async () => tokens.shift() ?? 'exhausted'),
      {fetch},
    )

    await createWikiDataClient(transport).getSnapshot()

    expect(seen.map(entry => entry.authorization?.match(/t-\d/u)?.[0])).toEqual(['t-1', 't-2', 't-3', 't-4'])
  })

  it('reports a token-source failure during a snapshot as unavailable', async () => {
    const transport = createReadTransport(
      readTokenSource(async () => {
        throw new Error('mint failed')
      }),
      {fetch: fakeFetch(() => ({})).fetch},
    )

    await expect(createWikiDataClient(transport).getSnapshot()).rejects.toBeInstanceOf(WikiDataUnavailableError)
  })

  it('keeps the read and write token sources distinct types', () => {
    const read = readTokenSource(async () => 'r')
    const write = writeTokenSource(async () => 'w')
    const options = {fetch: fakeFetch(() => ({})).fetch}

    // @ts-expect-error a write source cannot build a read transport
    const wrongRead = () => createReadTransport(write, options)
    // @ts-expect-error a read source cannot build a write transport
    const wrongWrite = () => createWriteTransport(read, options)
    // @ts-expect-error a bare function is neither source
    const bare = () => createReadTransport(async () => 'x', options)

    expect([wrongRead, wrongWrite, bare]).toHaveLength(3)
    expect(read.kind).not.toBe(write.kind)
  })
})
