/**
 * Pure `notificationclick` resolver, imported by `sw.ts`.
 *
 * `sw.ts` is top-level Workbox code that tests cannot import, so the click
 * logic lives here and takes the SW `clients` surface as an argument. No
 * module state, no `console.*` calls (a run ID must never be logged), and no
 * navigation target is ever built from wire text: the only dynamic value is a
 * `runId` that passes `RUN_ID_PATTERN` (re-checked here, since the data was
 * stored with the notification and may predate this worker).
 *
 * Behavior (only app windows count, for every type: URL pathname `/`, so a
 * `/privacy` tab is never focused or messaged):
 *   - pick the focused app window, then a visible one, then any;
 *   - `question` with a valid `runId`: only controlled windows are considered
 *     (the page accepts `OPEN_RUN` only from its controlling worker); focus the
 *     pick (a `focus()` failure is swallowed) and post `{type: 'OPEN_RUN', runId}`
 *     to that one client; with no controlled app window, open `/#<runId>`;
 *   - every other case (other types, a question with no valid `runId`, data
 *     from an older worker): all windows, controlled or not, are considered;
 *     focus the pick, post nothing; with no app window, open `/`.
 */

import {RUN_ID_PATTERN} from '../operator/run-id.ts'

/** The slice of `WindowClient` the resolver uses. */
export interface ClickWindowClient {
  readonly url: string
  readonly focused: boolean
  readonly visibilityState: string
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}

/** The slice of the SW `clients` global the resolver uses. */
export interface ClickClients {
  matchAll(options: {type: 'window'; includeUncontrolled: boolean}): Promise<readonly ClickWindowClient[]>
  openWindow(url: string): Promise<unknown>
}

/** The `runId` of a question notification's stored data, or `undefined` for anything else. */
function readStoredQuestionRunId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const {type, runId} = data as Record<string, unknown>
  if (type !== 'question' || typeof runId !== 'string') return undefined
  return RUN_ID_PATTERN.test(runId) ? runId : undefined
}

function isAppWindow(client: ClickWindowClient): boolean {
  try {
    return new URL(client.url).pathname === '/'
  } catch {
    return false
  }
}

/** Focused first, then visible, then any. */
function pickAppWindow(windowClients: readonly ClickWindowClient[]): ClickWindowClient | undefined {
  const appWindows = windowClients.filter(isAppWindow)
  return (
    appWindows.find(client => client.focused) ??
    appWindows.find(client => client.visibilityState === 'visible') ??
    appWindows[0]
  )
}

/**
 * Resolve a notification click against the open windows and act on it.
 * `data` is the notification's stored `data`, treated as untrusted.
 */
export async function handleNotificationClick(clients: ClickClients, data: unknown): Promise<void> {
  const runId = readStoredQuestionRunId(data)
  // The OPEN_RUN message is only accepted from the worker that controls the page, so a question with
  // a run ID looks only at controlled windows: an uncontrolled one (a page loaded before this worker
  // activated) would take the focus and silently drop the message. With none, the run opens in a new
  // window. Every other click keeps looking at all windows, since it only focuses one.
  const windowClients = await clients.matchAll({type: 'window', includeUncontrolled: runId === undefined})
  const target = pickAppWindow(windowClients)

  if (target === undefined) {
    await clients.openWindow(runId === undefined ? '/' : `/#${runId}`)
    return
  }

  if (runId === undefined) {
    await target.focus()
    return
  }

  try {
    await target.focus()
  } catch {
    // Focus can be refused; the page still needs to learn which run to open.
  }
  target.postMessage({type: 'OPEN_RUN', runId})
}
