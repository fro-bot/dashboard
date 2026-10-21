/**
 * A small, lint-clean wiki used by the gates and write-operation tests.
 */

import {rebuildWikiIndex, serializeCorrections, type CorrectionRecord} from '@fro.bot/wiki-write-core'

export const ALPHA = 'knowledge/wiki/repos/acme--alpha.md'
export const BETA = 'knowledge/wiki/repos/acme--beta.md'
export const TOPIC = 'knowledge/wiki/topics/beta-topic.md'
export const GAMMA = 'knowledge/wiki/entities/gamma.md'
export const INDEX = 'knowledge/index.md'
export const LOG = 'knowledge/log.md'
export const CORRECTIONS = 'knowledge/corrections.yaml'

export const ALPHA_ID = 'repos.acme--alpha'
export const BETA_ID = 'repos.acme--beta'
export const GAMMA_ID = 'entities.gamma'

export const ALPHA_BODY = '\n# acme/alpha\n\nAlpha builds widgets for factories. See [[beta-topic]] and [[acme--beta]].\n'
export const BETA_BODY = '\n# acme/beta\n\nBeta ships gadgets worldwide. See [[beta-topic]] and [[acme--alpha]].\n'

export const WORKFLOW = '.github/workflows/merge-data.yaml'
export const DOC = 'docs/plans/2026-01-01-001-plan.md'

function page(values: Record<string, string>, body: string): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

export function wikiPages(): Record<string, string> {
  return {
    [ALPHA]: page(
      {type: 'repo', title: 'acme/alpha', created: '2026-01-01', updated: '2026-02-01', node_id: 'R_alpha'},
      ALPHA_BODY,
    ),
    [BETA]: page(
      {type: 'repo', title: 'acme/beta', created: '2026-01-01', updated: '2026-02-01', node_id: 'R_beta'},
      BETA_BODY,
    ),
    [TOPIC]: page(
      {type: 'topic', title: 'Beta topic', created: '2026-01-01', updated: '2026-02-01'},
      '\n# Beta topic\n\nTopic about [[acme--alpha]], [[acme--beta]] and [[gamma]].\n',
    ),
    [GAMMA]: page(
      {type: 'entity', title: 'Gamma', created: '2026-01-01', updated: '2026-02-01'},
      '\n# Gamma\n\nGamma is a tool used by [[acme--alpha]].\n',
    ),
  }
}

export function wikiFiles(extra: Record<string, string> = {}): Record<string, string> {
  const pages = wikiPages()
  return {
    ...pages,
    [INDEX]: rebuildWikiIndex({existingIndex: '# Wiki Index\n\nMaster catalog.\n', wikiFiles: pages}),
    [LOG]: '# Wiki Log\n\n---\n',
    'knowledge/wiki/README.md': '# Wiki\n\nNo frontmatter on purpose.\n',
    'metadata/repos.yaml': 'version: 1\nrepos: []\n',
    [WORKFLOW]: 'name: merge-data\n',
    [DOC]: '# plan\n',
    ...extra,
  }
}

export function correctionRecord(
  id: string,
  pageNodeId: string,
  text: string,
  extra: Partial<CorrectionRecord> = {},
): CorrectionRecord {
  return {id, page_node_id: pageNodeId, span: {text}, state: 'active', ...extra} as CorrectionRecord
}

export function correctionsYaml(...records: CorrectionRecord[]): string {
  return serializeCorrections({version: 1, corrections: records})
}
