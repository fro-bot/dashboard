/**
 * Contract: what the web client sends for a save is what the server's request parser accepts.
 *
 * The client builds marks from the draft (`web/src/wiki/marks.ts`) and sends them with
 * `saveWikiPage`. The server's `parseSaveRequest` is the authority on the wire shape. This test feeds
 * the one into the other, so a change on either side that breaks the contract fails here instead of
 * as an `invalid-request` rejection in production.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'
import {parseSaveRequest} from '../src/wiki/write-operation.ts'
import {saveWikiPage} from '../web/src/api/wiki.ts'
import {createMark, saveMarksOf, type Mark} from '../web/src/wiki/marks.ts'

const OPERATION_ID = '11111111-2222-4333-8444-555555555555'
const DIGEST = 'a'.repeat(64)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Call the client's `saveWikiPage` and return the JSON body it put on the wire, with the page ID the route adds. */
async function wireBodyFor(body: string, marks: ReturnType<typeof saveMarksOf>, transitions: {id: string; action: 'retire' | 'flag' | 'reconfirm'}[]) {
  let sent: unknown
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: {body: string}) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({state: 'saved', operationId: OPERATION_ID, commitSha: 'c1', committedAt: '2026-10-21T10:00:00Z'}), {
        status: 200,
      })
    }),
  )
  await saveWikiPage({
    pageId: 'repos.acme--alpha',
    operationId: OPERATION_ID,
    pageBlobSha: 'blob-1',
    correctionsBase: DIGEST,
    body,
    marks,
    transitions,
  })
  return {pageId: 'repos.acme--alpha', ...(sent as object)}
}

function markOn(text: string, quoted: string, existing: readonly Mark[] = []): Mark {
  const start = text.indexOf(quoted)
  const result = createMark(text, {start, end: start + quoted.length}, existing)
  if (!result.ok) throw new Error(result.reason)
  return result.mark
}

describe('the save request the client sends', () => {
  it('is accepted by the server parser with marks and transitions intact', async () => {
    const body = '\n# acme/alpha\n\nAlpha builds gadgets.\n'
    const mark = markOn(body, 'gadgets')
    const wire = await wireBodyFor(body, saveMarksOf(body, [mark]), [
      {id: 'c1', action: 'retire'},
      {id: 'c2', action: 'flag'},
    ])

    const parsed = parseSaveRequest(wire)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.marks).toEqual([{text: 'gadgets', start: body.indexOf('gadgets'), end: body.indexOf('gadgets') + 7}])
    expect(parsed.value.transitions).toEqual([
      {id: 'c1', action: 'retire'},
      {id: 'c2', action: 'flag'},
    ])
  })

  it('is accepted when the marks end the body, hold emoji, and use UTF-16 offsets', async () => {
    const body = 'Say \u{1F44D}\u{1F3FD} and cafe\u0301'
    const mark = markOn(body, '\u{1F44D}\u{1F3FD} and cafe\u0301')
    const marks = saveMarksOf(body, [mark])
    const wire = await wireBodyFor(body, marks, [])

    const parsed = parseSaveRequest(wire)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.marks).toEqual(marks)
    expect(parsed.value.marks[0]?.end).toBe(body.length)
    // The server counts the same unit the client does, so the span text is the body's slice.
    for (const sent of parsed.value.marks) expect(body.slice(sent.start, sent.end)).toBe(sent.text)
  })

  it('is accepted with neither marks nor transitions', async () => {
    const wire = await wireBodyFor('body', [], [])
    expect(parseSaveRequest(wire).ok).toBe(true)
  })

  it('is refused by the server when a mark reaches past the body, which the client never sends', async () => {
    const wire = await wireBodyFor('short', [{text: 'short and long', start: 0, end: 14}], [])
    expect(parseSaveRequest(wire)).toEqual({ok: false, reason: 'invalid-request'})
  })
})
