import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {CLAIMS, REQUIRED_CLAIM_CATEGORIES} from './claims.ts'

const pagePath = resolve(import.meta.dirname, '../../privacy.html')
const page = readFileSync(pagePath, 'utf8')
const pageText = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('public privacy policy content', () => {
  it('covers every required claim category', () => {
    const categoryEvidence: Record<(typeof REQUIRED_CLAIM_CATEGORIES)[number], RegExp> = {
      'stored-fields': /what is stored when you subscribe/i,
      'read-surface': /what you can read back/i,
      retention: /how long data is kept/i,
      deletion: /deleting your data/i,
      deactivation: /when a subscription stops being used/i,
      audit: /what is logged/i,
      'vapid-rotation': /rotating the signing key/i,
      relay: /who else receives your data/i,
      payload: /what notifications contain/i,
      'export-surface': /no separate export/i,
    }

    for (const category of REQUIRED_CLAIM_CATEGORIES) {
      expect(pageText, `missing ${category}`).toMatch(categoryEvidence[category])
    }
  })

  it('tells a reader how current the policy is', () => {
    // Presence and shape only. Asserting the literal date would make every
    // content edit a two-place change and the test would pin the very string
    // it exists to protect.
    expect(pageText).toMatch(/last updated\s+\d{1,2}\s+\w+\s+\d{4}/i)
  })

  it('publishes configurable retention durations without making guarantees', () => {
    const inactive = CLAIMS.inactiveRetention.value
    const tombstone = CLAIMS.tombstoneRetention.value

    expect(pageText).toMatch(new RegExp(`${inactive.amount} ${inactive.unit}.{0,80}(default|configurable)`, 'i'))
    expect(pageText).toMatch(new RegExp(`${tombstone.amount} ${tombstone.unit}.{0,80}(default|configurable)`, 'i'))
  })

  it('states the relay TTL and urgency disclosures', () => {
    expect(pageText).toMatch(/time-to-live of four weeks/i)
    expect(pageText).toMatch(/normal urgency/i)
    expect(pageText).not.toMatch(/sets no explicit/i)
  })

  it('discloses that a dispatch record identifies its triggering run', () => {
    // The Gateway sets a dispatch record's correlation id to the triggering
    // run/approval id, so the record is run-linkable. Describing it only as a
    // "correlation identifier" reads as an opaque trace value and understates
    // what is kept. This pins the disclosure against that regression.
    expect(pageText).toMatch(/run or approval that triggered/i)
    expect(pageText).not.toMatch(/never record.{0,120}run detail/i)
  })

  // UNGUARDED, deliberately: "They cover two events: a run is waiting for
  // your approval, and a run failed." The dispatch trigger set
  // ('approval' | 'run_failed') is Gateway-internal — not in the vendored
  // contract (src/gateway/operator-contract/push.ts covers only the read
  // surface: VAPID key, handoff state, subscription metadata). A test here
  // could only assert the page says what the page says. Guardable once the
  // trigger set is exposed in the operator contract, the way
  // OPERATOR_CONTRACT_VERSION already is.

  it('does not expose private or internal values', () => {
    const urls = pageText.match(/https:\/\/[^\s<)]+/g) ?? []
    expect(urls).toEqual(['https://github.com/fro-bot/dashboard/issues'])
    expect(pageText).not.toMatch(/[A-Za-z0-9_-]{80,}/)
    expect(pageText).not.toMatch(/\/operator\//)
    expect(pageText).not.toMatch(/(?<![\w.-])\d{7,}(?![\w.-])/)
    expect(page).not.toMatch(/<script\b/i)
  })
})
