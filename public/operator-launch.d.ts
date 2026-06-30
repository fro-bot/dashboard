/**
 * Type declarations for public/operator-launch.js.
 *
 * Provides TypeScript types for the pure exported functions so that
 * test/operator-launch-core.test.ts can import them without `any`.
 */

// ---------------------------------------------------------------------------
// Launch outcome discriminated union
// ---------------------------------------------------------------------------

export type LaunchOutcome =
  | {readonly kind: 'launched'; readonly runId: string}
  | {readonly kind: 'not-found'}
  | {readonly kind: 'rate-limited'}
  | {readonly kind: 'failure'}

// ---------------------------------------------------------------------------
// Pending card hook descriptor
// ---------------------------------------------------------------------------

export interface PendingCardHooks {
  readonly runId: string
  /** CSS selector for the per-card [data-role="run-status"] element */
  readonly statusElSelector: string
  /** CSS selector for the shared [data-role="stream-status"] notice element */
  readonly noticeElSelector: string
}

// ---------------------------------------------------------------------------
// Client interface (minimal — for submitLaunch injection)
// ---------------------------------------------------------------------------

export interface LaunchClient {
  readonly refreshCsrf: () => Promise<
    | {readonly success: true; readonly data: {readonly csrfToken: string}}
    | {readonly success: false; readonly error: {readonly kind: string; readonly status?: number; readonly message?: string}}
  >
  readonly launchRun: (req: {
    readonly repo: string
    readonly prompt: string
    readonly csrfToken: string
    readonly idempotencyKey: string
  }) => Promise<
    | {readonly success: true; readonly data: {readonly runId: string}}
    | {readonly success: false; readonly error: {readonly kind: string; readonly status?: number; readonly message?: string}}
  >
}

// ---------------------------------------------------------------------------
// Pure exported functions
// ---------------------------------------------------------------------------

/**
 * Validate a single repo item from the listRepos response.
 *
 * A valid item must be a non-null object with string owner and string repo.
 * channelName is optional but must be a string if present.
 *
 * Returns true if the item is valid, false otherwise.
 */
export declare function validateRepoItem(item: unknown): boolean

/**
 * Mint a fresh unique idempotency key for a launch submission.
 * Uses crypto.randomUUID() with a fallback.
 */
export declare function mintIdempotencyKey(): string

/**
 * Submit a launch request through the injected client.
 *
 * Pure state machine: refreshCsrf → launchRun → on 400, refresh + retry once
 * reusing the SAME idempotency key. Maps 404→not-found, 429→rate-limited,
 * all other errors→failure.
 */
export declare function submitLaunch(
  client: LaunchClient,
  params: {readonly repo: string; readonly prompt: string},
  idempotencyKey: string,
): Promise<LaunchOutcome>

/**
 * Build the hook descriptor for an optimistic pending run card.
 * Returns the runId and the CSS selectors for the status and notice elements.
 */
export declare function buildPendingCardHooks(runId: string): PendingCardHooks

// ---------------------------------------------------------------------------
// DOM shell (browser-only — never called at module top-level)
// ---------------------------------------------------------------------------

/**
 * Returns the module specifier for operator-stream that includes ?manual=1.
 * Exported so tests can assert the correct specifier without intercepting dynamic imports.
 */
export declare function streamModuleSpecifier(): string

/**
 * Build a browser-direct launch client.
 *
 * Accepts an optional endpointBase (default: '/operator') so the runtime-loader
 * seam can configure a different endpoint base in dev mode without modifying
 * production behavior. Also accepts optional scenario and fixtureSessionId for
 * dev-mode launches.
 */
export declare function buildLaunchClient(opts?: {
  readonly endpointBase?: string
  /** Called at submit time to get the current scenario; not frozen at init. */
  readonly getScenario?: () => string
  readonly fixtureSessionId?: string
}): {
  readonly refreshCsrf: () => Promise<
    | {readonly success: true; readonly data: {readonly csrfToken: string}}
    | {readonly success: false; readonly error: {readonly kind: string; readonly status?: number; readonly message?: string}}
  >
  readonly listRepos: () => Promise<
    | {readonly success: true; readonly data: readonly {readonly owner: string; readonly repo: string; readonly channelName?: string}[]}
    | {readonly success: false; readonly error: {readonly kind: string; readonly status?: number; readonly message?: string}}
  >
  readonly launchRun: (req: {
    readonly repo: string
    readonly prompt: string
    readonly csrfToken: string
    readonly idempotencyKey: string
  }) => Promise<
    | {readonly success: true; readonly data: {readonly runId: string}}
    | {readonly success: false; readonly error: {readonly kind: string; readonly status?: number; readonly message?: string}}
  >
}

/**
 * Initialize the operator launch UI.
 * Builds a browser OperatorClient, renders the repo picker, wires the launch
 * form, and on success inserts an optimistic pending card + calls initOperatorStream.
 *
 * Must only be called from a browser context.
 */
export declare function initOperatorLaunch(opts?: {
  readonly endpointBase?: string
  /** Called at submit time to get the current scenario; not frozen at init. */
  readonly getScenario?: () => string
  readonly fixtureSessionId?: string
  readonly onRunLaunched?: (runId: string, card: HTMLElement) => void
}): Promise<void>

/**
 * Set the launch-created stream handle.
 *
 * Called internally by initOperatorLaunch after a successful launch to track
 * the stream handle so resetLaunchState() can close it. Exported for testing
 * so tests can inject a fake handle without calling the DOM-touching initOperatorLaunch.
 */
export declare function setLaunchStreamHandle(handle: {close: () => void}): void

/**
 * Reset the launch-initialized flag.
 * Called by the React runtime seam cleanup to allow remount after auth expiry.
 * Internal to the runtime seam contract — not part of the public operator API.
 */
export declare function resetLaunchState(): void

/**
 * Returns true if the given init is no longer the active init.
 *
 * An init is stale when its AbortController signal is aborted or its captured
 * generation no longer matches the current generation counter. Called after every
 * await in initOperatorLaunch to bail out of stale inits before they register
 * listeners or mutate the DOM.
 *
 * Exported for testing.
 */
export declare function isInitStale(controller: AbortController, generation: number): boolean

/**
 * Test-only seam: directly set _launchGeneration.
 *
 * Allows tests to simulate the Strict Mode race condition without calling the
 * DOM-touching initOperatorLaunch. Never call this in production code.
 */
export declare function setLaunchGeneration(gen: number): void

/**
 * Test-only seam: directly set _launchListenerController and its owning generation.
 *
 * Allows tests to simulate the listener registration step of initOperatorLaunch
 * without calling the DOM-touching function. The generation parameter must match
 * the generation that "owns" this controller — resetLaunchState() will only abort
 * the controller if _launchListenerGeneration matches the pre-increment generation.
 *
 * Never call this in production code.
 */
export declare function setLaunchListenerController(controller: AbortController, generation: number): void
