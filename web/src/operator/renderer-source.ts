/**
 * Where the runtime loader gets the output renderer from.
 *
 * Production loads the Markdown module with a literal-path dynamic import, so Vite keeps it in its own
 * chunk. The loader starts that import alongside the operator modules and never waits on it before
 * initializing, so in a spec the real import and the run index's init settle a fraction of a millisecond
 * apart, in either order, and a module-registry mock cannot reliably hold one back. Specs therefore
 * install a source with `setOutputRendererLoader` (test-setup.ts installs an already-resolved one before
 * every spec): a resolved promise settles before any module import the loader awaits can, and a spec
 * that needs a renderer that is pending, failing or slow passes a promise it controls.
 */

import type {renderOutput} from './markdown-output.ts'

export type OutputRenderer = typeof renderOutput

type RendererLoader = () => Promise<OutputRenderer | undefined>

const defaultLoader: RendererLoader = async () => (await import('./markdown-output.ts')).renderOutput

let currentLoader: RendererLoader = defaultLoader

/** Start loading the renderer. Rejects, or resolves to undefined, when there is none. */
export function loadOutputRenderer(): Promise<OutputRenderer | undefined> {
  return currentLoader()
}

/** Set the renderer source; with no argument the source is the Markdown module import. Tests only. */
export function setOutputRendererLoader(loader?: RendererLoader): void {
  currentLoader = loader ?? defaultLoader
}
