/**
 * Save-time gates and correction changes.
 *
 * Pure functions over a file map. Nothing here touches the network or a
 * credential. The shared gates in `@fro.bot/wiki-write-core` do the checking:
 * regeneration of the log and index, wikilink validation, correction survival,
 * lint, and the rendering policy.
 */

import type {CorrectionRecord, CorrectionsFile} from '@fro.bot/wiki-write-core'

import {
  buildWikiIngestChanges,
  CorrectionStoreError,
  flagCorrectionForReconfirmation,
  lintWikiSnapshot,
  parseCorrections,
  reconfirmCorrection,
  recordCorrection,
  retireCorrection,
  serializeCorrections,
  validateRenderingPolicy,
  WikiIngestError,
} from '@fro.bot/wiki-write-core'
import {CORRECTIONS_PATH, parseWikiPagePath, WIKI_INDEX_PATH, WIKI_LOG_PATH} from './paths.ts'

const METADATA_PATH = 'metadata/repos.yaml'
const GATE_ROOT_FILES: ReadonlySet<string> = new Set([WIKI_INDEX_PATH, WIKI_LOG_PATH, CORRECTIONS_PATH, METADATA_PATH])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SaveMark {
  readonly text: string
  readonly start: number
  readonly end: number
}

export type TransitionAction = 'retire' | 'flag' | 'reconfirm'

export interface SaveTransition {
  readonly id: string
  readonly action: TransitionAction
}

export interface GateFinding {
  readonly kind: string
  readonly path: string
  readonly message: string
  readonly target?: string
}

export type GateResult =
  | {readonly ok: true; readonly files: Record<string, string>}
  | {readonly ok: false; readonly findings: readonly GateFinding[]}

export interface GateInput {
  readonly pagePath: string
  /** The full page document: frontmatter and body. */
  readonly pageContent: string
  /** Snapshot files. Filtered to what the shared gates expect before use. */
  readonly files: Record<string, string>
  /** Corrections as they will be stored, after this save's changes. */
  readonly corrections: CorrectionsFile
  readonly correctionsChanged: boolean
  readonly now: Date
}

export interface CorrectionChanges {
  /** The page's `node_id`, or null when it has none. */
  readonly nodeId: string | null
  readonly marks: readonly SaveMark[]
  readonly transitions: readonly SaveTransition[]
  readonly actor: string
  readonly recordedAt: string
  readonly newId: () => string
}

export type CorrectionChangeResult =
  | {readonly ok: true; readonly file: CorrectionsFile}
  | {readonly ok: false; readonly reason: 'mark-unavailable' | 'invalid-transition' | 'invalid-request'}

// ---------------------------------------------------------------------------
// File selection and corrections
// ---------------------------------------------------------------------------

/**
 * The files the shared gates read: pages in the four page directories, the
 * `knowledge/` root files, and the metadata file. The gates treat every `.md`
 * under `knowledge/wiki/` as a page, so files such as `knowledge/wiki/README.md`
 * must stay out.
 */
export function selectGateFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => parseWikiPagePath(path) !== null || GATE_ROOT_FILES.has(path)),
  )
}

/** A missing corrections file is the empty set. An empty or unparseable one is null. */
export function readCorrectionsFile(files: Record<string, string>): CorrectionsFile | null {
  const raw = files[CORRECTIONS_PATH]
  if (raw === undefined) return {version: 1, corrections: []}
  if (raw.trim() === '') return null
  try {
    return parseCorrections(raw)
  } catch {
    return null
  }
}

function applyTransition(file: CorrectionsFile, transition: SaveTransition): CorrectionsFile {
  switch (transition.action) {
    case 'retire':
      return retireCorrection(file, transition.id)
    case 'flag':
      return flagCorrectionForReconfirmation(file, transition.id)
    case 'reconfirm':
      return reconfirmCorrection(file, transition.id)
  }
}

/**
 * Apply staged transitions, then new marks, to the corrections as read. A
 * transition may only touch an entry of this page.
 */
export function applyCorrectionChanges(file: CorrectionsFile, changes: CorrectionChanges): CorrectionChangeResult {
  if (changes.marks.length === 0 && changes.transitions.length === 0) return {ok: true, file}
  if (changes.nodeId === null) {
    return {ok: false, reason: changes.marks.length > 0 ? 'mark-unavailable' : 'invalid-transition'}
  }
  const {nodeId} = changes

  let next = file
  try {
    for (const transition of changes.transitions) {
      const owned = next.corrections.some(record => record.id === transition.id && record.page_node_id === nodeId)
      if (!owned) return {ok: false, reason: 'invalid-transition'}
      next = applyTransition(next, transition)
    }
  } catch (error) {
    const transitionFailure =
      error instanceof CorrectionStoreError &&
      (error.code === 'INVALID_TRANSITION' || error.code === 'CORRECTION_NOT_FOUND')
    return {ok: false, reason: transitionFailure ? 'invalid-transition' : 'invalid-request'}
  }

  try {
    for (const mark of changes.marks) {
      next = recordCorrection(next, {
        id: changes.newId(),
        pageNodeId: nodeId,
        span: {text: mark.text, start: mark.start, end: mark.end},
        serverDerivedAttribution: {actor: changes.actor, recorded_at: changes.recordedAt},
      })
    }
  } catch {
    return {ok: false, reason: 'invalid-request'}
  }
  return {ok: true, file: next}
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function toFinding(finding: {kind: string; path: string; message: string; target?: string | undefined}): GateFinding {
  return {
    kind: finding.kind,
    path: finding.path,
    message: finding.message,
    ...(finding.target === undefined ? {} : {target: finding.target}),
  }
}

/**
 * Run the shared build, survival, lint, and rendering checks for one page edit.
 * A repo page keeps its existing `node_id`; the build never migrates or deletes.
 * On success `files` holds the page, the appended log, the rebuilt index, and
 * the corrections file when it changed. A gate error that carries findings
 * becomes a rejection with those findings; any other throw is a generic
 * rejection with none.
 */
export function runWikiGates(input: GateInput): GateResult {
  try {
    const existingFiles = selectGateFiles(input.files)
    const built = buildWikiIngestChanges({
      existingFiles: {...existingFiles},
      operation: 'manual-edit',
      target: input.pagePath,
      summary: `Manual correction to ${input.pagePath}`,
      timestamp: input.now,
      sources: [],
      pages: [{path: input.pagePath, content: input.pageContent}],
      corrections: input.corrections,
      // With no tracked identities the build would drop a repo page's node_id.
      // Marking the metadata unknown makes it keep the page's existing identity.
      trackedMetadataAvailable: false,
    })

    const files = {...built.files}
    if (input.correctionsChanged) files[CORRECTIONS_PATH] = serializeCorrections(input.corrections)

    const lint = lintWikiSnapshot({files: {...existingFiles, ...files}, now: input.now})
    const rendering = validateRenderingPolicy({path: input.pagePath, content: input.pageContent})
    // Reconfirmation findings are advisory: flagging a correction must not block the save.
    const blocking = built.findings.filter(finding => finding.kind !== 'correction-needs-reconfirmation')
    const findings = [...blocking, ...lint.deterministicFindings, ...rendering].map(toFinding)
    return findings.length === 0 ? {ok: true, files} : {ok: false, findings}
  } catch (error) {
    if (error instanceof WikiIngestError) return {ok: false, findings: error.findings.map(toFinding)}
    return {ok: false, findings: []}
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const GENERIC_MESSAGE = 'The submitted content was refused by a check.'

const FINDING_MESSAGES: Readonly<Record<string, string>> = {
  'broken-wikilink': 'A wiki link points to a page that does not exist.',
  'broken-markdown-link': 'A link points to a page that does not exist.',
  'unsafe-html': 'The page contains HTML that is not allowed.',
  'correction-eroded': 'A marked correction is no longer present in the page.',
  'correction-needs-reconfirmation': 'A marked correction needs reconfirmation.',
  'corrupt-corrections': 'The corrections file cannot be read.',
  'missing-frontmatter': 'The page is missing its frontmatter.',
  'invalid-frontmatter': 'The page frontmatter is not valid.',
  'orphan-page': 'The page is not linked from anywhere.',
  'index-drift': 'The page index does not match the pages.',
}

export interface FindingSubmission {
  /** Text the operator submitted: the body and the mark texts. */
  readonly texts: readonly string[]
  /** Correction IDs of the page being saved. */
  readonly knownIds: ReadonlySet<string>
}

/**
 * Reduce findings to what is safe to return. A finding keeps its `target` only
 * when that text occurs in the submission or is a correction ID of this page.
 * The gate's own message is replaced by a fixed one for the kind, because gate
 * messages can quote page text.
 */
export function boundFindings(findings: readonly GateFinding[], submission: FindingSubmission): GateFinding[] {
  return findings.map(finding => {
    const target = finding.target
    const keep =
      target !== undefined &&
      target !== '' &&
      (submission.knownIds.has(target) || submission.texts.some(text => text.includes(target)))
    return {
      kind: finding.kind,
      path: finding.path,
      message: FINDING_MESSAGES[finding.kind] ?? GENERIC_MESSAGE,
      ...(keep ? {target} : {}),
    }
  })
}

export type {CorrectionRecord}
