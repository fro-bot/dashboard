/**
 * Root-level parity between three sources of truth for push notification kinds:
 *   - the vendored contract's `OPERATOR_PUSH_TRIGGER_KINDS` (src/),
 *   - the service worker's runtime `PUSH_NOTIFICATION_TYPES` (web/src/),
 *   - the sentences on the public privacy page (web/privacy.html).
 *
 * Lives in root `test/` because `web/src` must not import `src/`
 * (web/src/operator/no-server-imports.test.ts) and the Docker builder copies only `web/`.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import {OPERATOR_PUSH_TRIGGER_KINDS, type OperatorPushTriggerKind} from '../src/gateway/operator-contract/index.ts'
import {PUSH_NOTIFICATION_TYPES} from '../web/src/push/sw-notification.ts'

const page = readFileSync(resolve(import.meta.dirname, '../web/privacy.html'), 'utf8')
const pageText = page.replaceAll(/<[^>]+>/g, ' ').replaceAll(/\s+/g, ' ')

/** The phrase the privacy page uses for each kind, as it appears in the event sentence. */
const EVENT_PHRASES = {
  approval: 'a run is waiting for your approval',
  question: 'a run is waiting for your answer',
  run_failed: 'a run failed',
} as const satisfies Record<OperatorPushTriggerKind, string>

function sentenceContaining(needle: RegExp): string {
  const sentences = pageText.split(/(?<=[.!?])\s+/)
  const match = sentences.find(sentence => needle.test(sentence))
  if (match === undefined) throw new Error(`no sentence on the privacy page matches ${String(needle)}`)
  return match
}

describe('push trigger kind parity', () => {
  it('PUSH_NOTIFICATION_TYPES equals the vendored OPERATOR_PUSH_TRIGGER_KINDS as a set', () => {
    expect(new Set<string>(PUSH_NOTIFICATION_TYPES)).toEqual(new Set<string>(OPERATOR_PUSH_TRIGGER_KINDS))
    expect(PUSH_NOTIFICATION_TYPES).toHaveLength(OPERATOR_PUSH_TRIGGER_KINDS.length)
  })

  it('the event phrase table covers every vendored kind', () => {
    expect(Object.keys(EVENT_PHRASES).sort()).toEqual([...OPERATOR_PUSH_TRIGGER_KINDS].sort())
  })

  it('the privacy page event sentence names every kind', () => {
    const eventSentence = sentenceContaining(/They cover .* events?:/i).toLowerCase()
    for (const kind of OPERATOR_PUSH_TRIGGER_KINDS) {
      expect(eventSentence, `event sentence missing ${kind}`).toContain(EVENT_PHRASES[kind])
    }
  })

  it('the event sentence announces as many events as there are kinds', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']
    const eventSentence = sentenceContaining(/They cover .* events?:/i).toLowerCase()
    expect(eventSentence).toContain(`they cover ${words[OPERATOR_PUSH_TRIGGER_KINDS.length]} events`)
  })
})

describe('privacy page payload sentence', () => {
  const payloadSentences = () => {
    const start = pageText.search(/What notifications contain/i)
    expect(start).toBeGreaterThan(-1)
    const rest = pageText.slice(start)
    const end = rest.search(/Who else receives your data/i)
    return end === -1 ? rest : rest.slice(0, end)
  }

  it('no longer claims notifications never carry run identifiers', () => {
    const section = payloadSentences()
    expect(section).not.toMatch(/never include[^.]*run identifiers/i)
    expect(section).not.toMatch(/never[^.]*run (id|identifier)s?\b/i)
  })

  it('states that question and approval notifications can carry the ID of the run they are about', () => {
    const section = payloadSentences()
    expect(section).toMatch(/question and approval notifications can carry the ID of the run they are about/i)
    expect(section).toMatch(/used only to open that run/i)
  })

  it('keeps the never-include list for everything else', () => {
    const section = payloadSentences().toLowerCase()
    for (const term of ['repository names', 'prompts', 'run output', 'endpoints', 'keys', 'tokens', 'cookies', 'session data']) {
      expect(section, `payload sentence lost "${term}"`).toContain(term)
    }
  })
})
