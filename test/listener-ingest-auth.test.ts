import {createHmac} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {verifyIngestSignature} from '../src/listener/ingest-auth.ts'

const KEY = 'test-shared-ingest-key'
const BODY = '{"source":"infra","kind":"deploy-health"}'

function sign(key: string, timestamp: string, rawBody: string): string {
  const hex = createHmac('sha256', key).update(`${timestamp}.${rawBody}`).digest('hex')
  return `sha256=${hex}`
}

describe('verifyIngestSignature', () => {
  it('valid signature+timestamp → ok', () => {
    const now = 1_700_000_000
    const timestampHeader = String(now)
    const signatureHeader = sign(KEY, timestampHeader, BODY)

    const result = verifyIngestSignature({
      key: KEY,
      rawBody: BODY,
      timestampHeader,
      signatureHeader,
      nowSeconds: now,
    })

    expect(result.success).toBe(true)
  })

  it('wrong key → err', () => {
    const now = 1_700_000_000
    const timestampHeader = String(now)
    const signatureHeader = sign('a-different-key', timestampHeader, BODY)

    const result = verifyIngestSignature({
      key: KEY,
      rawBody: BODY,
      timestampHeader,
      signatureHeader,
      nowSeconds: now,
    })

    expect(result.success).toBe(false)
  })

  it('tampered body → err', () => {
    const now = 1_700_000_000
    const timestampHeader = String(now)
    const signatureHeader = sign(KEY, timestampHeader, BODY)

    const result = verifyIngestSignature({
      key: KEY,
      rawBody: `${BODY}tampered`,
      timestampHeader,
      signatureHeader,
      nowSeconds: now,
    })

    expect(result.success).toBe(false)
  })

  it('bad signature format → err', () => {
    const now = 1_700_000_000
    const timestampHeader = String(now)

    const result = verifyIngestSignature({
      key: KEY,
      rawBody: BODY,
      timestampHeader,
      signatureHeader: 'not-a-valid-signature',
      nowSeconds: now,
    })

    expect(result.success).toBe(false)
  })

  it('missing headers → err', () => {
    const now = 1_700_000_000

    expect(
      verifyIngestSignature({
        key: KEY,
        rawBody: BODY,
        timestampHeader: null,
        signatureHeader: sign(KEY, String(now), BODY),
        nowSeconds: now,
      }).success,
    ).toBe(false)

    expect(
      verifyIngestSignature({
        key: KEY,
        rawBody: BODY,
        timestampHeader: String(now),
        signatureHeader: null,
        nowSeconds: now,
      }).success,
    ).toBe(false)
  })

  it('timestamp outside window → err; inside window → ok', () => {
    const now = 1_700_000_000

    const outsideTimestamp = String(now - 301)
    const outsideSig = sign(KEY, outsideTimestamp, BODY)
    expect(
      verifyIngestSignature({
        key: KEY,
        rawBody: BODY,
        timestampHeader: outsideTimestamp,
        signatureHeader: outsideSig,
        nowSeconds: now,
      }).success,
    ).toBe(false)

    const insideTimestamp = String(now - 299)
    const insideSig = sign(KEY, insideTimestamp, BODY)
    expect(
      verifyIngestSignature({
        key: KEY,
        rawBody: BODY,
        timestampHeader: insideTimestamp,
        signatureHeader: insideSig,
        nowSeconds: now,
      }).success,
    ).toBe(true)
  })

  it('constant-time path does not throw on signature length mismatch', () => {
    const now = 1_700_000_000
    const timestampHeader = String(now)

    expect(() =>
      verifyIngestSignature({
        key: KEY,
        rawBody: BODY,
        timestampHeader,
        signatureHeader: 'sha256=abcd',
        nowSeconds: now,
      }),
    ).not.toThrow()
  })
})
