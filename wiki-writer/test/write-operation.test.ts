import {createHash} from 'node:crypto'
import {GATE_CONTRACT_VERSION} from '@fro-bot/wiki-write-core'
import {describe, expect, it, vi} from 'vitest'
import {WIKI_REF, WIKI_REPOSITORY, type GitHubDataClient} from '../src/github-data-client.ts'
import {createOperationLedger} from '../src/operation-ledger.ts'
import {createSharedWikiWriteGates, createWikiWriteOperation, type WikiWriteGateInput, type WikiWriteGates, type WikiWriteRequest} from '../src/write-operation.ts'

const OPERATION_ID = '22222222-2222-4222-8222-222222222222'
const PATH = 'knowledge/wiki/topics/example.md'
const CONTENT = '# Corrected example\n'

function request(overrides: Partial<WikiWriteRequest> = {}): WikiWriteRequest {
  return {
    operation: 'write',
    operationId: OPERATION_ID,
    repository: WIKI_REPOSITORY,
    ref: WIKI_REF,
    path: PATH,
    content: CONTENT,
    expectedParentSha: 'head-1',
    ...overrides,
  }
}

function snapshot(content = '---\ntype: topic\ntitle: Example\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# Old example\n') {
  return {
    headSha: 'head-1',
    treeSha: 'tree-1',
    files: {[PATH]: content},
    fileShas: {[PATH]: 'blob-1'},
  }
}

function createClient(overrides: Partial<GitHubDataClient> = {}): GitHubDataClient {
  const getSnapshot = vi.fn<GitHubDataClient['getSnapshot']>().mockResolvedValue(snapshot())
  const createBlob = vi.fn<GitHubDataClient['createBlob']>().mockResolvedValue('blob-2')
  const createTree = vi.fn<GitHubDataClient['createTree']>().mockResolvedValue('tree-2')
  const createCommit = vi.fn<GitHubDataClient['createCommit']>().mockResolvedValue('commit-2')
  const updateRef = vi.fn<GitHubDataClient['updateRef']>().mockResolvedValue(undefined)
  const getCommit = vi.fn<GitHubDataClient['getCommit']>().mockResolvedValue({sha: 'commit-2', message: `docs: edit\n\nFro-Operation-Id: ${OPERATION_ID}`, parents: ['head-1']})
  return {
    getSnapshot,
    createBlob,
    createTree,
    createCommit,
    updateRef,
    getCommit,
    ...overrides,
  }
}

const gates: WikiWriteGates = {
  run: async ({existingFiles, path, content}: WikiWriteGateInput) => ({ok: true as const, files: {...existingFiles, [path]: content}, findings: []}),
}

function checker() {
  return {check: vi.fn().mockResolvedValue({
    proceed: true as const,
    marker: {version: GATE_CONTRACT_VERSION, sourceTreeHash: 'source-1'},
    readiness: {ready: true, stale: false, mainHeadSha: 'main-1'},
  })}
}

describe('wiki write operation', () => {
  it('reconstructs system frontmatter and creates one Fro Bot-attributed commit intent', async () => {
    const client = createClient()
    const ledger = createOperationLedger(':memory:')
    const createBlob = vi.fn<GitHubDataClient['createBlob']>(async () => {
      expect(ledger.get(OPERATION_ID)).toMatchObject({state: 'pending'})
      return 'blob-2'
    })
    const createCommit = vi.fn<GitHubDataClient['createCommit']>(async input => {
      expect(input.parentSha).toBe('head-1')
      expect(input.message).toContain(`Fro-Operation-Id: ${OPERATION_ID}`)
      expect(input.author?.name).toBe('Fro Bot')
      return 'commit-2'
    })
    const clientWithHook: GitHubDataClient = {...client, createBlob, createCommit}
    const operation = createWikiWriteOperation({client: clientWithHook, ledger, gates, gateContractChecker: checker()})

    await expect(operation.execute(request())).resolves.toMatchObject({state: 'succeeded', commitSha: 'commit-2'})
    expect(createCommit).toHaveBeenCalledOnce()
    expect(client.updateRef).toHaveBeenCalledOnce()
    expect(ledger.get(OPERATION_ID)).toMatchObject({state: 'succeeded', expectedParentSha: 'head-1'})
    ledger.close()
  })

  it('returns a conflict before ref update when the observed parent is stale', async () => {
    const client = createClient({getSnapshot: vi.fn().mockResolvedValue({...snapshot(), headSha: 'head-2'})})
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await expect(operation.execute(request())).resolves.toEqual({state: 'conflict', status: 412})
    expect(client.updateRef).not.toHaveBeenCalled()
    ledger.close()
  })

  it('rejects an out-of-scope target before contract or GitHub access', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(snapshot())
    const contract = checker()
    const client = createClient({getSnapshot})
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: contract})

    await expect(operation.execute(request({repository: 'other/repo'}))).resolves.toEqual({state: 'rejected', reason: 'target'})
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(contract.check).not.toHaveBeenCalled()
    ledger.close()
  })

  it('returns a conflict before ref update when the blob validator is stale', async () => {
    const client = createClient()
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await expect(operation.execute(request({expectedBlobSha: 'blob-stale'}))).resolves.toEqual({state: 'conflict', status: 412})
    expect(client.updateRef).not.toHaveBeenCalled()
    ledger.close()
  })

  it('persists marked corrections in the sidecar file rather than page frontmatter', async () => {
    const gateResult = await createSharedWikiWriteGates().run({
      path: PATH,
      content: '---\ntype: topic\ntitle: Example\ncreated: 2026-01-01\nupdated: 2026-01-01\nnode_id: node-1\n---\n\n# Corrected example\nMarked fact\n',
      existingFiles: {
        [PATH]: '---\ntype: topic\ntitle: Example\ncreated: 2026-01-01\nupdated: 2026-01-01\nnode_id: node-1\n---\n\n# Old example\n',
        'knowledge/index.md': '# Wiki Index\n',
        'knowledge/log.md': '# Wiki Log\n',
      },
      corrections: [{
        id: 'correction-1',
        pageNodeId: 'node-1',
        span: {text: 'Marked fact'},
        serverDerivedAttribution: {actor: 'operator-1', recorded_at: '2026-09-03T00:00:00.000Z'},
      }],
      now: new Date('2026-09-03T00:00:00.000Z'),
    })

    expect(gateResult.ok).toBe(true)
    if (gateResult.ok) {
      expect(gateResult.files['knowledge/corrections.yaml']).toContain('correction-1')
      expect(gateResult.files[PATH]).not.toContain('correction-1')
    }
  })

  it('surfaces gate rejection without leaking text absent from submitted content', async () => {
    const secret = 'private upstream secret'
    const rejectingGates: WikiWriteGates = {
      run: vi.fn().mockResolvedValue({ok: false, findings: [{kind: 'unsafe-html', path: PATH, message: secret}]}),
    }
    const client = createClient()
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates: rejectingGates, gateContractChecker: checker()})

    const result = await operation.execute(request())
    expect(result).toMatchObject({state: 'rejected'})
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(client.updateRef).not.toHaveBeenCalled()
    ledger.close()
  })

  it('refuses a mismatched gate contract before creating a ledger intent', async () => {
    const client = createClient()
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({
      client,
      ledger,
      gates,
      gateContractChecker: {check: vi.fn().mockResolvedValue({
        proceed: false as const,
        reason: 'version_mismatch' as const,
        readiness: {ready: false, stale: false, mainHeadSha: 'main-1'},
      })},
    })

    await expect(operation.execute(request())).resolves.toEqual({state: 'rejected', reason: 'gate-contract'})
    expect(ledger.list()).toHaveLength(0)
    ledger.close()
  })

  it('maps a non-fast-forward update failure to a 412 without retrying', async () => {
    const updateRef = vi.fn().mockRejectedValue(Object.assign(new Error('non-fast-forward'), {status: 422}))
    const client = createClient({updateRef})
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await expect(operation.execute(request())).resolves.toEqual({state: 'conflict', status: 412})
    expect(updateRef).toHaveBeenCalledOnce()
    expect(ledger.get(OPERATION_ID)).toMatchObject({state: 'failed'})
    ledger.close()
  })

  it('keeps matching content indeterminate when the operation trailer is absent', async () => {
    const desired = `---\ntype: topic\ntitle: Example\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${CONTENT}`
    const client = createClient({
      updateRef: vi.fn().mockRejectedValue(new Error('response lost')),
      getSnapshot: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot(desired)),
      getCommit: vi.fn().mockResolvedValue({sha: 'head-2', message: 'docs: another identical edit', parents: ['head-1']}),
    })
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await expect(operation.execute(request())).resolves.toEqual({state: 'indeterminate', operationId: OPERATION_ID})
    expect(ledger.listIndeterminate()).toHaveLength(1)
    ledger.close()
  })

  it('does not issue a blind write when an indeterminate operation is submitted again', async () => {
    const updateRef = vi.fn().mockRejectedValue(new Error('response lost'))
    const client = createClient({
      updateRef,
      getSnapshot: vi.fn()
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValue({...snapshot(), headSha: 'unrelated-head'}),
      getCommit: vi.fn().mockResolvedValue({sha: 'unrelated-head', message: 'unrelated', parents: []}),
    })
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await operation.execute(request())
    await expect(operation.execute(request())).resolves.toEqual({state: 'indeterminate', operationId: OPERATION_ID})
    expect(updateRef).toHaveBeenCalledOnce()
    ledger.close()
  })

  it('reconciles an ambiguous write only when trailer, parent, and digest all match', async () => {
    const desired = `---\ntype: topic\ntitle: Example\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${CONTENT}`
    const client = createClient({
      updateRef: vi.fn().mockRejectedValue(new Error('response lost')),
      getSnapshot: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue({...snapshot(desired), headSha: 'commit-2'}),
    })
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await expect(operation.execute(request())).resolves.toMatchObject({state: 'succeeded', commitSha: 'commit-2'})
    expect(ledger.get(OPERATION_ID)).toMatchObject({state: 'succeeded', commitSha: 'commit-2'})
    ledger.close()
  })

  it('rejects content over the decoded ceiling before fetching GitHub state', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(snapshot())
    const client = createClient({getSnapshot})
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    const result = await operation.execute(request({content: 'x'.repeat(512 * 1024 + 1)}))
    expect(result).toMatchObject({state: 'rejected', reason: 'content-too-large'})
    expect(getSnapshot).not.toHaveBeenCalled()
    ledger.close()
  })
})

describe('write operation discrimination fixture', () => {
  it('uses the final reconstructed content digest as the ledger identity', async () => {
    const client = createClient()
    const ledger = createOperationLedger(':memory:')
    const operation = createWikiWriteOperation({client, ledger, gates, gateContractChecker: checker()})

    await operation.execute(request())

    const stored = ledger.get(OPERATION_ID)
    expect(stored?.contentDigest).toBe(createHash('sha256').update(`---\ntype: topic\ntitle: Example\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${CONTENT}`).digest('hex'))
    ledger.close()
  })
})
