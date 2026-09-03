import type {GateContractDecision} from './gate-contract.ts'
import type {OperationLedger, OperationRecord} from './operation-ledger.ts'
import {Buffer} from 'node:buffer'
import {createHash, randomUUID} from 'node:crypto'
import {
  buildWikiIngestChanges,
  lintWikiSnapshot,
  parseCorrections,
  reconstructFrontmatter,
  recordCorrection,
  serializeCorrections,
  validateRenderingPolicy,
  type CorrectionsFile,
  type RecordCorrectionInput,
} from '@fro-bot/wiki-write-core'
import {
  assertAllowedTarget,
  type GitHubDataClient,
  type GitHubSnapshot,
  type TreeEntry,
} from './github-data-client.ts'

export const MAX_RAW_ENVELOPE_BYTES = 1024 * 1024
export const MAX_DECODED_CONTENT_BYTES = 512 * 1024
export const OPERATION_TRAILER = 'Fro-Operation-Id'
export const FRO_BOT_IDENTITY = {
  name: 'Fro Bot',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
} as const

export interface WikiWriteRequest {
  readonly operation: 'write'
  readonly operationId: string
  readonly repository: string
  readonly ref: string
  readonly path: string
  readonly content: string
  readonly expectedParentSha: string
  readonly expectedBlobSha?: string
  readonly corrections?: readonly RecordCorrectionInput[]
}

export interface WikiWriteGateInput {
  readonly path: string
  readonly content: string
  readonly existingFiles: Record<string, string>
  readonly corrections?: readonly RecordCorrectionInput[]
  readonly now: Date
}

export interface WikiWriteGateFinding {
  readonly kind: string
  readonly path: string
  readonly message: string
  readonly target?: string
}

export type WikiWriteGateResult =
  | {readonly ok: true; readonly files: Record<string, string>; readonly findings: readonly WikiWriteGateFinding[]}
  | {readonly ok: false; readonly findings: readonly WikiWriteGateFinding[]}

export interface WikiWriteGates {
  readonly run: (input: WikiWriteGateInput) => WikiWriteGateResult | Promise<WikiWriteGateResult>
}

export interface GateContractChecker {
  readonly check: () => Promise<GateContractDecision>
}

export interface WikiWriteOperationOptions {
  readonly client: GitHubDataClient
  readonly ledger: OperationLedger
  readonly gates?: WikiWriteGates
  readonly gateContractChecker: GateContractChecker
  readonly now?: () => number
}

export type WikiWriteResult =
  | {readonly state: 'succeeded'; readonly operationId: string; readonly commitSha: string}
  | {readonly state: 'conflict'; readonly status: 412}
  | {readonly state: 'rejected'; readonly reason: 'target' | 'content-too-large' | 'invalid-request' | 'gate' | 'gate-contract'; readonly findings?: readonly WikiWriteGateFinding[]}
  | {readonly state: 'failed'; readonly operationId: string; readonly correlationId: string}
  | {readonly state: 'indeterminate'; readonly operationId: string}

export interface WikiWriteOperation {
  readonly execute: (request: WikiWriteRequest) => Promise<WikiWriteResult>
}

export function createWikiWriteOperation(options: WikiWriteOperationOptions): WikiWriteOperation {
  const gates = options.gates ?? createSharedWikiWriteGates()
  const now = options.now ?? (() => Date.now())

  async function execute(request: WikiWriteRequest): Promise<WikiWriteResult> {
    try {
      assertAllowedTarget(request.repository, request.ref, request.path)
    } catch {
      return {state: 'rejected', reason: 'target'}
    }

    if (!isValidRequest(request)) return {state: 'rejected', reason: 'invalid-request'}
    if (Buffer.byteLength(request.content, 'utf8') > MAX_DECODED_CONTENT_BYTES) {
      return {state: 'rejected', reason: 'content-too-large'}
    }

    const contract = await options.gateContractChecker.check()
    if (!contract.proceed) return {state: 'rejected', reason: 'gate-contract'}

    const existing = options.ledger.get(request.operationId)
    if (existing !== undefined) return resultFromExisting(existing)

    let snapshot: GitHubSnapshot
    try {
      snapshot = await options.client.getSnapshot()
    } catch {
      return {state: 'failed', operationId: request.operationId, correlationId: randomUUID()}
    }

    if (snapshot.headSha !== request.expectedParentSha) return {state: 'conflict', status: 412}

    const existingContent = snapshot.files[request.path]
    if (existingContent === undefined) return {state: 'rejected', reason: 'invalid-request'}
    if (request.expectedBlobSha !== undefined && snapshot.fileShas[request.path] !== request.expectedBlobSha) {
      return {state: 'conflict', status: 412}
    }

    let submittedContent: string
    try {
      submittedContent = request.path === 'knowledge/corrections.yaml'
        ? request.content
        : reconstructFrontmatter(existingContent, request.content)
    } catch {
      return {state: 'rejected', reason: 'gate'}
    }

    let gateResult: WikiWriteGateResult
    try {
      gateResult = await gates.run({
        path: request.path,
        content: submittedContent,
        existingFiles: snapshot.files,
        corrections: request.corrections,
        now: new Date(now()),
      })
    } catch {
      return {state: 'rejected', reason: 'gate'}
    }
    if (!gateResult.ok) return {state: 'rejected', reason: 'gate', findings: boundFindings(gateResult.findings, request.content)}

    const files = gateResult.files
    const contentDigest = digest(submittedContent)
    options.ledger.begin({
      operationId: request.operationId,
      repository: request.repository,
      ref: request.ref,
      path: request.path,
      expectedParentSha: request.expectedParentSha,
      contentDigest,
      createdAt: now(),
    })

    const changedEntries: TreeEntry[] = []
    try {
      for (const [path, content] of Object.entries(files)) {
        if (snapshot.files[path] === content) continue
        changedEntries.push({path, sha: await options.client.createBlob(content)})
      }
    } catch {
      completeLedger(options.ledger, request.operationId, {state: 'failed', updatedAt: now()}, now)
      return {state: 'failed', operationId: request.operationId, correlationId: randomUUID()}
    }
    if (changedEntries.length === 0) {
      completeLedger(options.ledger, request.operationId, {state: 'failed', updatedAt: now()}, now)
      return {state: 'rejected', reason: 'invalid-request'}
    }

    const message = `docs(knowledge): manual edit ${request.path}\n\n${OPERATION_TRAILER}: ${request.operationId}`
    try {
      const treeSha = await options.client.createTree(snapshot.treeSha, changedEntries)
      const commitSha = await options.client.createCommit({
        treeSha,
        parentSha: snapshot.headSha,
        message,
        author: FRO_BOT_IDENTITY,
        committer: FRO_BOT_IDENTITY,
      })
      try {
        await options.client.updateRef(commitSha)
      } catch (error) {
        if (statusOf(error) === 422) {
          completeLedger(options.ledger, request.operationId, {state: 'failed', updatedAt: now()}, now)
          return {state: 'conflict', status: 412}
        }

        const reconciliation = await reconcile(options.client, request, contentDigest)
        if (reconciliation.state === 'succeeded') {
          completeLedger(options.ledger, request.operationId, {state: 'succeeded', commitSha: reconciliation.commitSha, updatedAt: now()}, now)
          return reconciliation
        }
        completeLedger(options.ledger, request.operationId, {state: 'indeterminate', updatedAt: now()}, now)
        return {state: 'indeterminate', operationId: request.operationId}
      }

      completeLedger(options.ledger, request.operationId, {state: 'succeeded', commitSha, updatedAt: now()}, now)
      return {state: 'succeeded', operationId: request.operationId, commitSha}
    } catch {
      completeLedger(options.ledger, request.operationId, {state: 'failed', updatedAt: now()}, now)
      return {state: 'failed', operationId: request.operationId, correlationId: randomUUID()}
    }
  }

  return {execute}
}

export function createSharedWikiWriteGates(): WikiWriteGates {
  return {
    run: ({path, content, existingFiles, corrections, now}) => {
      if (path === 'knowledge/corrections.yaml') {
        const parsed = parseCorrections(content)
        return {ok: true, files: {[path]: serializeCorrections(parsed)}, findings: []}
      }

      const currentCorrections = readCorrectionsFile(existingFiles['knowledge/corrections.yaml'])
      const nextCorrections = applyCorrections(currentCorrections, corrections)
      const built = buildWikiIngestChanges({
        existingFiles,
        operation: 'manual-edit',
        target: path,
        summary: `Manual correction to ${path}`,
        timestamp: now,
        sources: [],
        pages: [{path, content}],
        corrections: nextCorrections,
      })
      const files = {...built.files}
      if (nextCorrections !== currentCorrections) files['knowledge/corrections.yaml'] = serializeCorrections(nextCorrections)

      const nextFiles = {...existingFiles, ...files}
      const lint = lintWikiSnapshot({files: nextFiles, now})
      const renderingFindings = path === 'knowledge/corrections.yaml' ? [] : validateRenderingPolicy({path, content})
      const findings: WikiWriteGateFinding[] = [
        ...built.findings,
        ...lint.deterministicFindings,
        ...renderingFindings,
      ]
      return findings.length === 0 ? {ok: true, files, findings} : {ok: false, findings}
    },
  }
}

async function reconcile(client: GitHubDataClient, request: WikiWriteRequest, contentDigest: string): Promise<{state: 'succeeded'; operationId: string; commitSha: string} | {state: 'indeterminate'}> {
  try {
    const snapshot = await client.getSnapshot()
    if (digest(snapshot.files[request.path] ?? '') !== contentDigest) return {state: 'indeterminate'}

    let sha = snapshot.headSha
    for (let depth = 0; depth < 32; depth += 1) {
      const commit = await client.getCommit(sha)
      const hasTrailer = new RegExp(`^${OPERATION_TRAILER}: ${escapeRegExp(request.operationId)}$`, 'mu').test(commit.message)
      const hasExpectedParent = commit.parents.includes(request.expectedParentSha)
      if (hasTrailer && hasExpectedParent) return {state: 'succeeded', operationId: request.operationId, commitSha: commit.sha}
      const next = commit.parents[0]
      if (next === undefined || next === request.expectedParentSha) break
      sha = next
    }
  } catch {
    return {state: 'indeterminate'}
  }
  return {state: 'indeterminate'}
}

function isValidRequest(request: WikiWriteRequest): boolean {
  return request.operation === 'write' &&
    typeof request.operationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(request.operationId) &&
    typeof request.expectedParentSha === 'string' &&
    request.expectedParentSha.length > 0
}

function completeLedger(ledger: OperationLedger, operationId: string, completion: Parameters<OperationLedger['complete']>[1], now: () => number): void {
  ledger.complete(operationId, completion)
  ledger.prune(now())
}

function resultFromExisting(record: OperationRecord): WikiWriteResult {
  if (record.state === 'succeeded' && record.commitSha !== null) return {state: 'succeeded', operationId: record.operationId, commitSha: record.commitSha}
  if (record.state === 'indeterminate') return {state: 'indeterminate', operationId: record.operationId}
  return {state: 'failed', operationId: record.operationId, correlationId: randomUUID()}
}

function boundFindings(findings: readonly WikiWriteGateFinding[], submittedContent: string): WikiWriteGateFinding[] {
  return findings.map(finding => ({
    kind: finding.kind,
    path: finding.path,
    ...(finding.target !== undefined && submittedContent.includes(finding.target) ? {target: finding.target} : {}),
    message: 'Gate rejected the submitted content.',
  }))
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const status = (error as {status?: unknown}).status
  return typeof status === 'number' ? status : undefined
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
}

function readCorrectionsFile(raw: string | undefined): CorrectionsFile {
  if (raw === undefined) return {version: 1, corrections: []}
  return parseCorrections(raw)
}

function applyCorrections(current: CorrectionsFile, inputs: readonly RecordCorrectionInput[] | undefined): CorrectionsFile {
  if (inputs === undefined || inputs.length === 0) return current
  return inputs.reduce((file, input) => recordCorrection(file, input), current)
}
