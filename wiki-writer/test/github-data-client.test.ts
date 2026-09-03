import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {
  assertAllowedTarget,
  createGitHubDataClientWithTransport,
  WIKI_REF,
  WIKI_REPOSITORY,
} from '../src/github-data-client.ts'

describe('GitHub data client', () => {
  it('rejects an out-of-scope target before invoking transport', () => {
    expect(() => assertAllowedTarget('other/repo', WIKI_REF, 'knowledge/wiki/topics/example.md')).toThrow('repository')
    expect(() => assertAllowedTarget(WIKI_REPOSITORY, 'main', 'knowledge/wiki/topics/example.md')).toThrow('ref')
    expect(() => assertAllowedTarget(WIKI_REPOSITORY, WIKI_REF, 'src/private.md')).toThrow('path')
  })

  it('reads a tree snapshot and decodes only blob files', async () => {
    const transport = {
      getRef: vi.fn().mockResolvedValue({data: {object: {sha: 'head-1'}}}),
      getCommit: vi.fn().mockResolvedValue({data: {sha: 'head-1', tree: {sha: 'tree-1'}, message: '', parents: []}}),
      getTree: vi.fn().mockResolvedValue({data: {tree: [
        {path: 'knowledge/wiki/topics/example.md', type: 'blob', sha: 'blob-1'},
        {path: 'ignored', type: 'tree', sha: 'tree-2'},
      ]}}),
      getBlob: vi.fn().mockResolvedValue({data: {content: Buffer.from('# Example\n').toString('base64'), encoding: 'base64'}}),
    }
    const client = createGitHubDataClientWithTransport(transport)

    await expect(client.getSnapshot()).resolves.toMatchObject({
      headSha: 'head-1',
      treeSha: 'tree-1',
      files: {'knowledge/wiki/topics/example.md': '# Example\n'},
    })
    expect(transport.getBlob).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', file_sha: 'blob-1'})
  })

  it('uses a non-forced ref update and supplies the observed parent to the commit', async () => {
    const transport = {
      createBlob: vi.fn().mockResolvedValue({data: {sha: 'blob-2'}}),
      createTree: vi.fn().mockResolvedValue({data: {sha: 'tree-2'}}),
      createCommit: vi.fn().mockResolvedValue({data: {sha: 'commit-2'}}),
      updateRef: vi.fn().mockResolvedValue({data: {}}),
    }
    const client = createGitHubDataClientWithTransport(transport)

    const blob = await client.createBlob('# Example\n')
    const tree = await client.createTree('tree-1', [{path: 'knowledge/wiki/topics/example.md', sha: blob}])
    await client.createCommit({treeSha: tree, parentSha: 'head-1', message: 'docs: edit\n\nFro-Operation-Id: op-1'})
    await client.updateRef('commit-2')

    expect(transport.createCommit).toHaveBeenCalledWith(expect.objectContaining({parents: ['head-1']}))
    expect(transport.updateRef).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', ref: 'heads/data', sha: 'commit-2', force: false})
  })
})
