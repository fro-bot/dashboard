/**
 * Bounded request-body reader, shared by routes that accept a body before (or without)
 * a session. The read stops at the cap, so an oversized body is never fully buffered.
 */
import {Buffer} from 'node:buffer'

// The platform reader resolves to `any` under the project's lint types, so the read loop is
// typed by this shape instead.
interface StreamReader {
  read: () => Promise<{done: boolean; value?: Uint8Array}>
  cancel: () => Promise<void>
}

export type BoundedBody = {readonly ok: true; readonly text: string} | {readonly ok: false}

/** Read at most `maxBytes`. A larger declared length is refused before reading; a longer stream is cancelled. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return {ok: false}
  if (request.body === null) return {ok: true, text: ''}

  const reader = request.body.getReader() as unknown as StreamReader
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done || value === undefined) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return {ok: false}
    }
    chunks.push(value)
  }
  return {ok: true, text: Buffer.concat(chunks).toString('utf8')}
}
