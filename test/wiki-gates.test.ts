import {lintWikiSnapshot, parseCorrections, reconstructFrontmatter} from '@fro.bot/wiki-write-core'
import {describe, expect, it} from 'vitest'
import {
  applyCorrectionChanges,
  boundFindings,
  readCorrectionsFile,
  runWikiGates,
  selectGateFiles,
} from '../src/wiki/gates.ts'
import {
  ALPHA,
  ALPHA_BODY,
  BETA,
  correctionRecord,
  CORRECTIONS,
  correctionsYaml,
  DOC,
  GAMMA,
  INDEX,
  LOG,
  TOPIC,
  wikiFiles,
  WORKFLOW,
} from './wiki-write-fixtures.ts'

const NOW = new Date('2030-01-01T00:00:00Z')
const EMPTY = {version: 1, corrections: []} as const

describe('selectGateFiles', () => {
  it('keeps pages, the knowledge root files, and the metadata file', () => {
    const selected = selectGateFiles(wikiFiles({[CORRECTIONS]: correctionsYaml()}))

    expect(Object.keys(selected).sort()).toEqual(
      [ALPHA, BETA, TOPIC, GAMMA, INDEX, LOG, CORRECTIONS, 'metadata/repos.yaml'].sort(),
    )
  })

  it.each([
    'knowledge/wiki/README.md',
    'knowledge/wiki/repos/nested/x.md',
    'knowledge/wiki/other/x.md',
    'knowledge/wiki/repos/x.txt',
    WORKFLOW,
    DOC,
  ])('drops %s, which would break or widen the shared gates', path => {
    expect(selectGateFiles({...wikiFiles(), [path]: 'no frontmatter\n'})).not.toHaveProperty(path)
  })

  it('leaves a lint-clean wiki lint-clean', () => {
    expect(lintWikiSnapshot({files: selectGateFiles(wikiFiles()), now: NOW}).deterministicFindings).toEqual([])
  })
})

describe('readCorrectionsFile', () => {
  it('treats a missing file as the empty set', () => {
    expect(readCorrectionsFile({})).toEqual(EMPTY)
  })

  it('parses a valid file', () => {
    const file = readCorrectionsFile({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'one'))})

    expect(file?.corrections.map(record => record.id)).toEqual(['c1'])
  })

  it.each([
    ['empty', ''],
    ['whitespace', ' \n '],
    ['invalid yaml', 'version: 1\ncorrections: [\n'],
    ['wrong version', 'version: 2\ncorrections: []\n'],
    ['bad entry', 'version: 1\ncorrections:\n  - id: c1\n'],
  ])('reports a %s file as corrupt', (_label, content) => {
    expect(readCorrectionsFile({[CORRECTIONS]: content})).toBeNull()
  })
})

describe('applyCorrectionChanges', () => {
  const base = {
    nodeId: 'R_alpha',
    actor: 'octocat',
    recordedAt: '2030-01-01T00:00:00.000Z',
    marks: [],
    transitions: [],
  }
  let counter = 0
  const newId = () => {
    counter += 1
    return `minted-${counter}`
  }

  it('records marks with server-minted IDs and the session attribution', () => {
    counter = 0
    const result = applyCorrectionChanges(EMPTY, {
      ...base,
      newId,
      marks: [
        {text: 'one', start: 0, end: 3},
        {text: 'two', start: 4, end: 7},
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.corrections.map(record => [record.id, record.page_node_id, record.attribution])).toEqual([
      ['minted-1', 'R_alpha', {actor: 'octocat', recorded_at: '2030-01-01T00:00:00.000Z'}],
      ['minted-2', 'R_alpha', {actor: 'octocat', recorded_at: '2030-01-01T00:00:00.000Z'}],
    ])
    expect(result.file.corrections[0]?.span).toEqual({text: 'one', start: 0, end: 3})
  })

  it('applies retire, flag, and reconfirm to this page entries', () => {
    const file = parseCorrections(
      correctionsYaml(
        correctionRecord('c-retire', 'R_alpha', 'a'),
        correctionRecord('c-flag', 'R_alpha', 'b'),
        correctionRecord('c-reconfirm', 'R_alpha', 'c', {state: 'needs-reconfirmation', reason: 'drift'}),
      ),
    )

    const result = applyCorrectionChanges(file, {
      ...base,
      newId,
      transitions: [
        {id: 'c-retire', action: 'retire'},
        {id: 'c-flag', action: 'flag'},
        {id: 'c-reconfirm', action: 'reconfirm'},
      ],
    })

    expect(result.ok && result.file.corrections.map(record => [record.id, record.state])).toEqual([
      ['c-retire', 'retired'],
      ['c-flag', 'needs-reconfirmation'],
      ['c-reconfirm', 'active'],
    ])
  })

  it('applies transitions before new marks', () => {
    const file = parseCorrections(correctionsYaml(correctionRecord('old', 'R_alpha', 'same text')))

    const result = applyCorrectionChanges(file, {
      ...base,
      newId: () => 'fresh',
      marks: [{text: 'same text', start: 0, end: 9}],
      transitions: [{id: 'old', action: 'retire'}],
    })

    expect(result.ok && result.file.corrections.map(record => [record.id, record.state])).toEqual([
      ['old', 'retired'],
      ['fresh', 'active'],
    ])
  })

  it('rejects a transition on another page entry', () => {
    const file = parseCorrections(correctionsYaml(correctionRecord('other', 'R_beta', 'x')))

    expect(applyCorrectionChanges(file, {...base, newId, transitions: [{id: 'other', action: 'retire'}]})).toEqual({
      ok: false,
      reason: 'invalid-transition',
    })
  })

  it.each([
    ['an unknown ID', 'missing', 'retire'],
    ['reconfirming an active entry', 'c1', 'reconfirm'],
  ] as const)('rejects %s', (_label, id, action) => {
    const file = parseCorrections(correctionsYaml(correctionRecord('c1', 'R_alpha', 'x')))

    expect(applyCorrectionChanges(file, {...base, newId, transitions: [{id, action}]})).toEqual({
      ok: false,
      reason: 'invalid-transition',
    })
  })

  it('rejects a transition on a retired entry', () => {
    const file = parseCorrections(correctionsYaml(correctionRecord('c1', 'R_alpha', 'x', {state: 'retired'})))

    expect(applyCorrectionChanges(file, {...base, newId, transitions: [{id: 'c1', action: 'flag'}]})).toEqual({
      ok: false,
      reason: 'invalid-transition',
    })
  })

  it('rejects marks and transitions on a page without a node_id', () => {
    const marked = applyCorrectionChanges(EMPTY, {...base, nodeId: null, newId, marks: [{text: 'x', start: 0, end: 1}]})
    const staged = applyCorrectionChanges(EMPTY, {...base, nodeId: null, newId, transitions: [{id: 'c', action: 'retire'}]})

    expect(marked).toEqual({ok: false, reason: 'mark-unavailable'})
    expect(staged).toEqual({ok: false, reason: 'invalid-transition'})
  })

  it('rejects a mark the core refuses', () => {
    expect(applyCorrectionChanges(EMPTY, {...base, newId, marks: [{text: '   ', start: 0, end: 3}]})).toEqual({
      ok: false,
      reason: 'invalid-request',
    })
  })

  it('rejects a minted ID that collides with an existing entry', () => {
    const file = parseCorrections(correctionsYaml(correctionRecord('dup', 'R_alpha', 'x')))

    expect(applyCorrectionChanges(file, {...base, newId: () => 'dup', marks: [{text: 'y', start: 0, end: 1}]})).toEqual({
      ok: false,
      reason: 'invalid-request',
    })
  })

  it('returns the same file object when nothing changes', () => {
    expect(applyCorrectionChanges(EMPTY, {...base, newId})).toEqual({ok: true, file: EMPTY})
  })
})

describe('runWikiGates', () => {
  const edited = (body: string) => reconstructFrontmatter(wikiFiles()[ALPHA] ?? '', body)

  function run(body: string, overrides: Partial<Parameters<typeof runWikiGates>[0]> = {}) {
    return runWikiGates({
      pagePath: ALPHA,
      pageContent: edited(body),
      files: wikiFiles(),
      corrections: EMPTY,
      correctionsChanged: false,
      now: NOW,
      ...overrides,
    })
  }

  it('returns the page, the appended log, and the index for a clean edit', () => {
    const result = run(ALPHA_BODY.replace('widgets', 'gadgets'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.files).sort()).toEqual([ALPHA, INDEX, LOG].sort())
    expect(result.files[LOG]).toContain('manual-edit')
    expect(result.files[LOG]).toContain(ALPHA)
    expect(result.files[LOG]?.startsWith('# Wiki Log')).toBe(true)
  })

  it('includes the corrections file only when it changed', () => {
    const next = parseCorrections(correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets')))

    const changed = run(ALPHA_BODY, {corrections: next, correctionsChanged: true})
    const same = run(ALPHA_BODY, {corrections: next, correctionsChanged: false})

    expect(changed.ok && Object.keys(changed.files)).toContain(CORRECTIONS)
    expect(same.ok && Object.keys(same.files)).not.toContain(CORRECTIONS)
  })

  it('rejects unsafe HTML with a finding', () => {
    const result = run(`${ALPHA_BODY}\n<script>alert(1)</script>\n`)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.findings.map(finding => finding.kind)).toContain('unsafe-html')
  })

  it('rejects a broken markdown link with a finding', () => {
    const result = run(`${ALPHA_BODY}\nSee [x](./no-such-page.md).\n`)

    expect(!result.ok && result.findings.map(finding => finding.kind)).toContain('broken-markdown-link')
  })

  it('rejects a broken wikilink as a generic rejection, because the core error carries no findings', () => {
    expect(run(`${ALPHA_BODY}\nSee [[no-such-page]].\n`)).toEqual({ok: false, findings: []})
  })

  it('keeps the node_id of a repo page, so its corrections still resolve', () => {
    const result = run(ALPHA_BODY.replace('widgets', 'gadgets'))

    expect(result.ok && result.files[ALPHA]).toContain('node_id: R_alpha')
  })

  it('keeps a repo page node_id when the page is saved with no change to the frontmatter', () => {
    const corrections = parseCorrections(correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets')))

    const result = run(ALPHA_BODY, {corrections, correctionsChanged: true})

    expect(result.ok).toBe(true)
  })

  it('does not block a save on an advisory reconfirmation finding', () => {
    const corrections = parseCorrections(
      correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets', {state: 'needs-reconfirmation', reason: 'drift'})),
    )

    expect(run(ALPHA_BODY.replace('widgets', 'gadgets'), {corrections, correctionsChanged: true}).ok).toBe(true)
  })

  it('rejects an eroded correction with the finding the core reports', () => {
    const corrections = parseCorrections(correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets')))

    const result = run(ALPHA_BODY.replace('Alpha builds widgets', 'Alpha makes things'), {corrections})

    expect(result.ok).toBe(false)
    expect(!result.ok && result.findings).toEqual([
      expect.objectContaining({kind: 'correction-eroded', path: ALPHA, target: 'c1'}),
    ])
  })

  it('passes the same body once the correction is retired', () => {
    const corrections = parseCorrections(
      correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets', {state: 'retired'})),
    )

    expect(run(ALPHA_BODY.replace('Alpha builds widgets', 'Alpha makes things'), {corrections, correctionsChanged: true}).ok).toBe(
      true,
    )
  })

  it('turns a gate error with no findings into a generic rejection', () => {
    const result = run('', {pageContent: 'no frontmatter at all\n'})

    expect(result).toEqual({ok: false, findings: []})
  })

  it('turns a non-ingest throw into a generic rejection', () => {
    const result = run('', {files: {...wikiFiles(), [LOG]: 5 as unknown as string}})

    expect(result).toEqual({ok: false, findings: []})
  })
})

describe('boundFindings', () => {
  const finding = {kind: 'broken-wikilink', path: ALPHA, message: 'Broken link to [[secret-repo]] in acme/alpha', target: 'secret-repo'}

  it('keeps target only when the text occurs in the submission', () => {
    const present = boundFindings([finding], {texts: ['see [[secret-repo]] here'], knownIds: new Set()})
    const absent = boundFindings([finding], {texts: ['nothing here'], knownIds: new Set()})

    expect(present[0]?.target).toBe('secret-repo')
    expect(absent[0]).not.toHaveProperty('target')
  })

  it('keeps a target that is a known correction ID of this page', () => {
    const eroded = {kind: 'correction-eroded', path: ALPHA, message: 'm', target: 'c1'}

    expect(boundFindings([eroded], {texts: ['body'], knownIds: new Set(['c1'])})[0]?.target).toBe('c1')
  })

  it('replaces the gate message with a fixed one that names no submitted text', () => {
    const [bounded] = boundFindings([finding], {texts: ['secret-repo'], knownIds: new Set()})

    expect(bounded?.message).not.toContain('secret-repo')
    expect(bounded?.message.length).toBeGreaterThan(0)
    expect(bounded).toMatchObject({kind: 'broken-wikilink', path: ALPHA})
  })

  it('gives an unknown kind a generic message', () => {
    expect(boundFindings([{kind: 'brand-new-kind', path: ALPHA, message: 'x'}], {texts: [], knownIds: new Set()})[0]?.message).toBe(
      'The submitted content was refused by a check.',
    )
  })
})
