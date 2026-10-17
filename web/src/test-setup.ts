import '@testing-library/jest-dom'
import {beforeEach} from 'vitest'

import {type OutputRenderer, setOutputRendererLoader} from './operator/renderer-source.ts'

// The runtime loader never waits on the renderer before initializing, so a spec that mounts it needs the
// renderer settled before any module import the loader awaits can finish. An already-resolved stub does
// that and keeps markdown-it out of every spec; specs that need the real renderer or a pending one
// install their own (see renderer-source.ts).
const stubRenderer = ((text: string, context: {doc: Document}) => {
  const fragment = context.doc.createDocumentFragment()
  fragment.append(text)
  return fragment
}) as unknown as OutputRenderer

beforeEach(() => {
  setOutputRendererLoader(() => Promise.resolve(stubRenderer))
})
