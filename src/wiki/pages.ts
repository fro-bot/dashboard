/**
 * Page list and page read models.
 *
 * Both read a full snapshot of the `data` tree through the injected data client.
 * A snapshot failure is an error result, never a partial list. A corrupt
 * corrections file is an error result, never an empty list.
 */

import type {CorrectionLifecycle, CorrectionRecord} from '@fro.bot/wiki-write-core'
import type {Result} from '../result.ts'
import type {GitHubSnapshot, WikiDataClient} from './data-client.ts'
import type {GateContractDecision, GateContractVerdict} from './gate-contract.ts'
import type {WikiPageType} from './paths.ts'

import {createHash} from 'node:crypto'
import {
  getCorrectionLifecycle,
  parseFrontmatterDocument,
  verifyCorrectionSurvival,
} from '@fro.bot/wiki-write-core'
import {err, ok} from '../result.ts'
import {WikiDataUnavailableError} from './data-client.ts'
import {classifyGateContract} from './gate-contract.ts'
import {readCorrectionsFile} from './gates.ts'
import {pageIdFor, parsePageId, parseWikiPagePath, resolvePagePath, WIKI_PAGE_TYPES} from './paths.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiPageSummary {
  readonly id: string
  readonly title: string
  readonly type: WikiPageType
  readonly updated: string | null
  /** True when the page has a `node_id`, the key corrections attach to. */
  readonly canMark: boolean
}

export interface WikiPageList {
  readonly headSha: string
  readonly pages: readonly WikiPageSummary[]
}

export interface PageCorrection {
  readonly id: string
  readonly status: CorrectionLifecycle
  readonly span: CorrectionRecord['span']
  readonly attribution: {readonly actor: string; readonly recordedAt: string} | null
  readonly reason: string | null
  readonly supersededBy: string | null
  /** An active correction whose span is no longer in the page's prose. */
  readonly stale: boolean
  /** The entry as stored, the unit the corrections digest covers. */
  readonly record: CorrectionRecord
}

/** Whether the caller may write, with a coarse reason when not. */
export type WriteAccess = {readonly canWrite: true} | {readonly canWrite: false; readonly reason: string}

export interface WikiPageReadModel {
  readonly id: string
  readonly type: WikiPageType
  readonly title: string
  readonly updated: string | null
  /** The page body without frontmatter, exactly as stored. */
  readonly body: string
  readonly pageBlobSha: string
  readonly nodeId: string | null
  readonly canMark: boolean
  readonly corrections: readonly PageCorrection[]
  /** Digest of this page's corrections entries, the base the corrections guard compares. */
  readonly correctionsBase: string
  readonly headSha: string
  readonly contract: GateContractVerdict
  readonly canWrite: boolean
  readonly canWriteReason: string | null
}

export type WikiPagesError =
  | {readonly kind: 'invalid-id'}
  | {readonly kind: 'not-found'}
  | {readonly kind: 'page-invalid'}
  | {readonly kind: 'corrections-corrupt'}
  | {readonly kind: 'unavailable'; readonly status: number | null}

export interface WikiPagesDeps {
  readonly client: Pick<WikiDataClient, 'getSnapshot'>
  readonly checkContract: () => Promise<GateContractDecision>
}

export interface WikiPages {
  readonly listPages: () => Promise<Result<WikiPageList, WikiPagesError>>
  readonly readPage: (id: string, access: WriteAccess) => Promise<Result<WikiPageReadModel, WikiPagesError>>
}

// ---------------------------------------------------------------------------
// Corrections digest
// ---------------------------------------------------------------------------

const DIGEST_PREFIX = 'wiki-corrections-v1'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entryValue]) => [key, canonical(entryValue)]),
    )
  }
  return value
}

/**
 * Digest of a set of corrections entries. Stable under entry order and key
 * order, and changes when any entry changes.
 */
export function correctionsDigest(entries: readonly unknown[]): string {
  const encoded = entries.map(entry => JSON.stringify(canonical(entry))).sort()
  return createHash('sha256').update(`${DIGEST_PREFIX}\n${JSON.stringify(encoded)}`).digest('hex')
}

export const EMPTY_CORRECTIONS_DIGEST = correctionsDigest([])

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedPageDocument {
  readonly title: string | null
  readonly updated: string | null
  readonly nodeId: string | null
  readonly body: string
}

function parsePage(content: string): ParsedPageDocument | null {
  try {
    const document = parseFrontmatterDocument(content)
    const {title, updated, node_id: nodeId} = document.values
    return {
      title: typeof title === 'string' && title !== '' ? title : null,
      updated: typeof updated === 'string' ? updated : null,
      nodeId: typeof nodeId === 'string' && nodeId !== '' ? nodeId : null,
      body: document.body,
    }
  } catch {
    return null
  }
}

function staleIds(path: string, content: string, entries: readonly CorrectionRecord[]): ReadonlySet<string> {
  if (entries.length === 0) return new Set()
  try {
    const result = verifyCorrectionSurvival({[path]: content}, {version: 1, corrections: entries})
    return new Set(result.deterministicFindings.map(finding => finding.target).filter((id): id is string => id !== undefined))
  } catch {
    return new Set()
  }
}

function toPageCorrection(record: CorrectionRecord, stale: boolean): PageCorrection {
  return {
    id: record.id,
    status: getCorrectionLifecycle(record),
    span: record.span,
    attribution:
      record.attribution === undefined
        ? null
        : {actor: record.attribution.actor, recordedAt: record.attribution.recorded_at},
    reason: record.state === 'needs-reconfirmation' ? record.reason : null,
    supersededBy: record.state === 'superseded' ? record.superseded_by : null,
    stale,
    record,
  }
}

/** The read-model entries for a page's corrections records, with the stale flag set. */
export function toPageCorrections(
  path: string,
  content: string,
  records: readonly CorrectionRecord[],
): PageCorrection[] {
  const stale = staleIds(path, content, records)
  return records.map(record => toPageCorrection(record, stale.has(record.id)))
}

function unavailable(error: unknown): WikiPagesError {
  return {kind: 'unavailable', status: error instanceof WikiDataUnavailableError ? error.status : null}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWikiPages(deps: WikiPagesDeps): WikiPages {
  async function checkContract(): Promise<GateContractVerdict> {
    try {
      return classifyGateContract(await deps.checkContract())
    } catch {
      return {ok: false, kind: 'unreadable', retry: true}
    }
  }

  async function listPages(): Promise<Result<WikiPageList, WikiPagesError>> {
    let snapshot: GitHubSnapshot
    try {
      snapshot = await deps.client.getSnapshot()
    } catch (error) {
      return err(unavailable(error))
    }

    const pages: WikiPageSummary[] = []
    for (const [path, content] of Object.entries(snapshot.files)) {
      const location = parseWikiPagePath(path)
      if (location === null) continue
      const id = pageIdFor(location.type, location.name)
      if (parsePageId(id) === null) continue
      const parsed = parsePage(content)
      pages.push({
        id,
        title: parsed?.title ?? location.name,
        type: location.type,
        updated: parsed?.updated ?? null,
        canMark: parsed?.nodeId !== null && parsed?.nodeId !== undefined,
      })
    }
    pages.sort(
      (left, right) =>
        WIKI_PAGE_TYPES.indexOf(left.type) - WIKI_PAGE_TYPES.indexOf(right.type) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    return ok({headSha: snapshot.headSha, pages})
  }

  async function readPage(id: string, access: WriteAccess): Promise<Result<WikiPageReadModel, WikiPagesError>> {
    const location = parsePageId(id)
    if (location === null) return err({kind: 'invalid-id'})

    let snapshot: GitHubSnapshot
    let contract: GateContractVerdict
    try {
      ;[snapshot, contract] = await Promise.all([deps.client.getSnapshot(), checkContract()])
    } catch (error) {
      return err(unavailable(error))
    }

    const path = resolvePagePath(id, new Set(Object.keys(snapshot.fileShas)))
    const content = path === null ? undefined : snapshot.files[path]
    const pageBlobSha = path === null ? undefined : snapshot.fileShas[path]
    if (path === null || content === undefined || pageBlobSha === undefined) return err({kind: 'not-found'})

    const parsed = parsePage(content)
    if (parsed === null) return err({kind: 'page-invalid'})

    const file = readCorrectionsFile(snapshot.files)
    if (file === null) return err({kind: 'corrections-corrupt'})

    const records =
      parsed.nodeId === null ? [] : file.corrections.filter(record => record.page_node_id === parsed.nodeId)

    return ok({
      id,
      type: location.type,
      title: parsed.title ?? location.name,
      updated: parsed.updated,
      body: parsed.body,
      pageBlobSha,
      nodeId: parsed.nodeId,
      canMark: parsed.nodeId !== null,
      corrections: toPageCorrections(path, content, records),
      correctionsBase: correctionsDigest(records),
      headSha: snapshot.headSha,
      contract,
      canWrite: access.canWrite,
      canWriteReason: access.canWrite ? null : access.reason,
    })
  }

  return {listPages, readPage}
}
