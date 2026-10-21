import {describe, expect, it} from 'vitest'
import {
  assertAllowedTarget,
  CORRECTIONS_PATH,
  isAllowedWikiPath,
  isWritablePath,
  pageIdFor,
  parsePageId,
  parseWikiPagePath,
  resolvePagePath,
  WIKI_INDEX_PATH,
  WIKI_LOG_PATH,
  WIKI_PAGE_TYPES,
  WIKI_REF,
  WIKI_REPOSITORY,
  writableSetFor,
} from '../src/wiki/paths.ts'

const TREE = new Set([
  'knowledge/wiki/repos/marcusrbrown--infra.md',
  'knowledge/wiki/topics/docker-containers.md',
  'knowledge/wiki/entities/mise.md',
  'knowledge/wiki/comparisons/a-vs-b.md',
  'knowledge/wiki/entities/.gitkeep',
  'knowledge/wiki/README.md',
  'knowledge/index.md',
  'knowledge/corrections.yaml',
  '.github/workflows/merge-data.yaml',
])

describe('isAllowedWikiPath', () => {
  it.each([
    'knowledge/wiki/repos/a.md',
    'knowledge/wiki/topics/a.md',
    'knowledge/wiki/entities/a.md',
    'knowledge/wiki/comparisons/a.md',
    'knowledge/wiki/repos/marcusrbrown--infra.md',
    CORRECTIONS_PATH,
  ])('allows %s', path => {
    expect(isAllowedWikiPath(path)).toBe(true)
  })

  it.each([
    'knowledge/wiki/repos/nested/a.md',
    'knowledge/wiki/repos/a.txt',
    'knowledge/wiki/repos/.gitkeep',
    'knowledge/wiki/other/a.md',
    'knowledge/wiki/README.md',
    'knowledge/index.md',
    'knowledge/log.md',
    'knowledge/corrections.yml',
    '.github/workflows/merge-data.yaml',
    '../knowledge/wiki/repos/a.md',
    '/knowledge/wiki/repos/a.md',
    'knowledge/wiki/repos/',
    '',
  ])('rejects %j', path => {
    expect(isAllowedWikiPath(path)).toBe(false)
  })
})

describe('assertAllowedTarget', () => {
  it('rejects an out-of-scope repository, ref, or path', () => {
    expect(() => assertAllowedTarget('other/repo', WIKI_REF, 'knowledge/wiki/topics/example.md')).toThrow('repository')
    expect(() => assertAllowedTarget(WIKI_REPOSITORY, 'main', 'knowledge/wiki/topics/example.md')).toThrow('ref')
    expect(() => assertAllowedTarget(WIKI_REPOSITORY, WIKI_REF, 'src/private.md')).toThrow('path')
  })

  it('accepts the wiki repository, the data ref, and an allowed path', () => {
    expect(() => assertAllowedTarget(WIKI_REPOSITORY, WIKI_REF, 'knowledge/wiki/topics/example.md')).not.toThrow()
    expect(() => assertAllowedTarget(WIKI_REPOSITORY, WIKI_REF, CORRECTIONS_PATH)).not.toThrow()
  })
})

describe('page ID encoding', () => {
  it('lists the four page directories', () => {
    expect([...WIKI_PAGE_TYPES]).toEqual(['repos', 'topics', 'entities', 'comparisons'])
  })

  it('round-trips a page path through its ID', () => {
    const parsed = parseWikiPagePath('knowledge/wiki/repos/marcusrbrown--infra.md')

    expect(parsed).toEqual({type: 'repos', name: 'marcusrbrown--infra'})
    expect(pageIdFor('repos', 'marcusrbrown--infra')).toBe('repos.marcusrbrown--infra')
    expect(parsePageId('repos.marcusrbrown--infra')).toEqual({type: 'repos', name: 'marcusrbrown--infra'})
  })

  it('does not treat the corrections file or non-page files as pages', () => {
    expect(parseWikiPagePath(CORRECTIONS_PATH)).toBeNull()
    expect(parseWikiPagePath('knowledge/wiki/README.md')).toBeNull()
    expect(parseWikiPagePath('knowledge/wiki/repos/nested/a.md')).toBeNull()
  })

  it('accepts a name with inner dots', () => {
    expect(parsePageId('entities.node.js')).toEqual({type: 'entities', name: 'node.js'})
  })

  it.each([
    '',
    'repos',
    'repos.',
    '.foo',
    'repos.foo.',
    'repos..',
    'repos...',
    'repos.a..b',
    'repos.-foo',
    'repos.foo-',
    '..',
    '.',
    'repos../../etc/passwd',
    'repos.a/b',
    String.raw`repos.a\b`,
    'repos.a%2Fb',
    'repos.%2e%2e',
    'repos.a%2e',
    '/etc/passwd',
    'knowledge/wiki/repos/x.md',
    'unknown.foo',
    'REPOS.foo',
    'repos.foo bar',
    'repos.foo\u0000',
    'repos.foo\n',
    'repos.fo\u00F6',
    `repos.${'a'.repeat(300)}`,
  ])('rejects the page ID %j before any lookup', id => {
    expect(parsePageId(id)).toBeNull()
    expect(resolvePagePath(id, TREE)).toBeNull()
  })
})

describe('resolvePagePath', () => {
  it('maps an ID to a path only by finding it in the tree', () => {
    expect(resolvePagePath('repos.marcusrbrown--infra', TREE)).toBe('knowledge/wiki/repos/marcusrbrown--infra.md')
    expect(resolvePagePath('topics.docker-containers', TREE)).toBe('knowledge/wiki/topics/docker-containers.md')
    expect(resolvePagePath('comparisons.a-vs-b', TREE)).toBe('knowledge/wiki/comparisons/a-vs-b.md')
  })

  it('returns null for a well-formed ID that is not in the tree', () => {
    expect(resolvePagePath('repos.unknown-page', TREE)).toBeNull()
    expect(resolvePagePath('topics.marcusrbrown--infra', TREE)).toBeNull()
  })

  it('never resolves a path outside the allowlist, whatever the tree holds', () => {
    const hostile = new Set([...TREE, 'knowledge/wiki/repos/x/../../../secrets.md', 'knowledge/wiki/repos/..md'])
    const ids = ['repos.x', 'repos..', 'repos...md', 'repos.x/../../../secrets', 'repos.index', 'entities.gitkeep']

    for (const id of ids) {
      const resolved = resolvePagePath(id, hostile)
      expect(resolved === null || isAllowedWikiPath(resolved)).toBe(true)
    }
    expect(resolvePagePath('repos.x/../../../secrets', hostile)).toBeNull()
  })
})

describe('write allowlist', () => {
  const PAGE = 'knowledge/wiki/repos/marcusrbrown--infra.md'

  it('lets a commit write exactly the page, the log, the index, and the corrections file', () => {
    expect([...writableSetFor(PAGE)].sort()).toEqual([PAGE, WIKI_LOG_PATH, WIKI_INDEX_PATH, CORRECTIONS_PATH].sort())
    expect(WIKI_LOG_PATH).toBe('knowledge/log.md')
    expect(WIKI_INDEX_PATH).toBe('knowledge/index.md')
  })

  it.each([
    'knowledge/schema.md',
    'knowledge/wiki/README.md',
    'knowledge/wiki/repos/other.md',
    'metadata/repos.yaml',
    '.github/workflows/merge-data.yaml',
    'docs/plan.md',
    '',
  ])('does not include %j', path => {
    expect(writableSetFor(PAGE).has(path)).toBe(false)
  })

  it('accepts only page paths, the log, the index, and the corrections file as writable', () => {
    for (const path of [PAGE, WIKI_LOG_PATH, WIKI_INDEX_PATH, CORRECTIONS_PATH]) expect(isWritablePath(path)).toBe(true)
    for (const path of ['knowledge/schema.md', 'metadata/repos.yaml', 'knowledge/wiki/README.md', 'knowledge/wiki/repos/a/b.md']) {
      expect(isWritablePath(path)).toBe(false)
    }
  })

  it('refuses a page path outside the allowlist', () => {
    expect(() => writableSetFor('knowledge/schema.md')).toThrow('path')
  })
})
