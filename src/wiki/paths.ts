/**
 * Wiki target and page-path allowlist.
 *
 * The editor can touch one repository, one branch, four page directories (one
 * level deep, `.md`), and the corrections file. A page ID names an existing
 * page: it maps to a path only by finding it in the current tree, never by
 * trusting a client-supplied path.
 */

export const WIKI_OWNER = 'fro-bot'
export const WIKI_REPO = '.github'
export const WIKI_REPOSITORY = `${WIKI_OWNER}/${WIKI_REPO}`
export const WIKI_REF = 'data'

export const CORRECTIONS_PATH = 'knowledge/corrections.yaml'
export const WIKI_INDEX_PATH = 'knowledge/index.md'
export const WIKI_LOG_PATH = 'knowledge/log.md'

/**
 * Paths whose blobs a snapshot reads. An entry ending in `/` is a directory
 * prefix; any other entry is an exact file. The shared gates read wiki pages
 * under `knowledge/wiki/`, the three `knowledge/` root files, and
 * `metadata/repos.yaml`. Every other path in the tree is untouched by a save.
 */
export const SNAPSHOT_PATH_PREFIXES = ['knowledge/', 'metadata/repos.yaml'] as const

/** Page directories, in the order the list presents them. */
export const WIKI_PAGE_TYPES = ['repos', 'topics', 'entities', 'comparisons'] as const

export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number]

const PAGE_PATH = /^knowledge\/wiki\/(repos|topics|entities|comparisons)\/([^/]+)\.md$/u

/**
 * A page ID is `<directory>.<name>`. The name starts and ends with a letter or
 * digit and holds only letters, digits, `.`, `_`, and `-`, so an ID carries no
 * separator, dot segment, escape, or control character.
 */
const PAGE_ID = /^(repos|topics|entities|comparisons)\.([A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)$/u
const MAX_PAGE_ID_LENGTH = 200

export interface ParsedPage {
  readonly type: WikiPageType
  readonly name: string
}

export function isAllowedWikiPath(path: string): boolean {
  return path === CORRECTIONS_PATH || PAGE_PATH.test(path)
}

export function isSnapshotPath(path: string): boolean {
  return SNAPSHOT_PATH_PREFIXES.some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
}

/** Any path a commit may write: a page, the log, the index, or the corrections file. */
export function isWritablePath(path: string): boolean {
  return path === WIKI_LOG_PATH || path === WIKI_INDEX_PATH || isAllowedWikiPath(path)
}

/** The exact set of paths one save to `pagePath` may write. */
export function writableSetFor(pagePath: string): ReadonlySet<string> {
  if (parseWikiPagePath(pagePath) === null) throw new Error('path is not allowed')
  return new Set([pagePath, WIKI_LOG_PATH, WIKI_INDEX_PATH, CORRECTIONS_PATH])
}

export function assertAllowedTarget(repository: string, ref: string, path: string): void {
  if (repository !== WIKI_REPOSITORY) throw new Error('repository is not allowed')
  if (ref !== WIKI_REF) throw new Error('ref is not allowed')
  if (!isAllowedWikiPath(path)) throw new Error('path is not allowed')
}

/** The directory and name of a page path, or null for any other path. */
export function parseWikiPagePath(path: string): ParsedPage | null {
  const match = PAGE_PATH.exec(path)
  const type = match?.[1] as WikiPageType | undefined
  const name = match?.[2]
  return type === undefined || name === undefined ? null : {type, name}
}

export function pageIdFor(type: WikiPageType, name: string): string {
  return `${type}.${name}`
}

/** Syntactic check of a page ID. Touches no tree and makes no request. */
export function parsePageId(id: string): ParsedPage | null {
  if (id.length > MAX_PAGE_ID_LENGTH || id.includes('..')) return null
  const match = PAGE_ID.exec(id)
  const type = match?.[1] as WikiPageType | undefined
  const name = match?.[2]
  return type === undefined || name === undefined ? null : {type, name}
}

/**
 * Map a page ID to its path by finding the path in the tree. Returns null when
 * the ID is malformed or no such page exists.
 */
export function resolvePagePath(id: string, treePaths: ReadonlySet<string>): string | null {
  const parsed = parsePageId(id)
  if (parsed === null) return null
  const path = `knowledge/wiki/${parsed.type}/${parsed.name}.md`
  return treePaths.has(path) && isAllowedWikiPath(path) ? path : null
}
