/**
 * Operator launch entrypoint — pure core + thin DOM shell.
 *
 * This file is valid plain ES module that runs in a browser as-is (no TS syntax,
 * no imports of Node/TS modules). It is also directly importable by Vitest (Node 24
 * ESM) because it uses only standard JS. DOM-touching code lives exclusively inside
 * initOperatorLaunch() and is never executed at module top-level.
 *
 * Architecture: pure exports (mintIdempotencyKey, submitLaunch, buildPendingCardHooks)
 * are tested by test/operator-launch-core.test.ts without a browser.
 * The DOM shell (initOperatorLaunch) is the only part that touches document.*.
 *
 * Security invariants:
 * - Never console.log/console.error/console.warn prompt, csrf, idempotency key,
 *   runId (except in the data-run-id attribute), or repo names.
 * - Render only safe fields; no data-* / error-copy / analytics that echoes
 *   prompt/csrf/idempotency/runId in logs.
 * - All 400s collapse to one generic failure; 404 → one uniform unavailable state.
 * - No cause inference from body or timing.
 * - credentials:'include', redirect:'error' on all fetch calls.
 * - The prompt is user-typed and goes only in the POST body — never in logs or DOM.
 * - runId appears only in the data-run-id attribute and the stream URL.
 */

// ---------------------------------------------------------------------------
// Pure: repo item validation
// ---------------------------------------------------------------------------

/**
 * Validate a single repo item from the listRepos response.
 *
 * A valid item must be a non-null object with string owner and string repo.
 * channelName is optional but must be a string if present.
 *
 * Returns true if the item is valid, false otherwise.
 * Exported so tests can exercise the validation logic directly.
 */
export function validateRepoItem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return false
  }
  if (typeof item.owner !== 'string' || typeof item.repo !== 'string') {
    return false
  }
  if (item.channelName !== undefined && typeof item.channelName !== 'string') {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Pure: idempotency key minting
// ---------------------------------------------------------------------------

/**
 * Mint a fresh unique idempotency key for a launch submission.
 * Uses crypto.randomUUID() with a fallback for environments that lack it.
 * Browser-valid: crypto.randomUUID is available in all modern browsers.
 */
export function mintIdempotencyKey() {
  if (
    globalThis.crypto !== undefined &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: timestamp + random hex (not cryptographically strong, but unique enough)
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2)
  return `${ts}-${rand}`
}

// ---------------------------------------------------------------------------
// Pure: launch outcome state machine
// ---------------------------------------------------------------------------

/**
 * Submit a launch request through the injected client.
 *
 * State machine:
 *   1. refreshCsrf → on failure → {kind:'failure'}
 *   2. launchRun({repo, prompt, csrfToken, idempotencyKey})
 *      - 202 {runId} → {kind:'launched', runId}
 *      - 400 (post-selection) → refreshCsrf ONCE + retry ONCE reusing the SAME key
 *        - retry 202 → {kind:'launched', runId}
 *        - retry 400 → {kind:'failure'} (no third attempt)
 *      - 404 → {kind:'not-found'} (uniform, no cause)
 *      - 429 → {kind:'rate-limited'}
 *      - any other error → {kind:'failure'}
 *
 * The idempotency key is passed in (not minted here) so the caller can reuse it
 * across retries and the function remains pure/testable.
 *
 * @param {object} client - An object with refreshCsrf() and launchRun() methods
 * @param {{repo: string, prompt: string}} params - Launch parameters
 * @param {string} idempotencyKey - The idempotency key to use (reused on retry)
 * @returns {Promise<LaunchOutcome>} The launch outcome discriminated union.
 */
export async function submitLaunch(client, params, idempotencyKey) {
  const {repo, prompt} = params

  // Step 1: Get initial CSRF token
  const csrfResult = await client.refreshCsrf()
  if (!csrfResult.success) {
    return {kind: 'failure'}
  }
  const csrfToken = csrfResult.data.csrfToken

  // Step 2: Attempt launch
  const launchResult = await client.launchRun({repo, prompt, csrfToken, idempotencyKey})

  if (launchResult.success) {
    return {kind: 'launched', runId: launchResult.data.runId}
  }

  const error = launchResult.error

  // 404 → uniform not-found (no cause, no retry)
  if (error.kind === 'http' && error.status === 404) {
    return {kind: 'not-found'}
  }

  // 429 → rate-limited (no retry)
  if (error.kind === 'http' && error.status === 429) {
    return {kind: 'rate-limited'}
  }

  // 400 → refresh CSRF once and retry ONCE reusing the SAME idempotency key
  if (error.kind === 'http' && error.status === 400) {
    const retrycsrfResult = await client.refreshCsrf()
    if (!retrycsrfResult.success) {
      return {kind: 'failure'}
    }
    const retryCsrfToken = retrycsrfResult.data.csrfToken

    const retryResult = await client.launchRun({
      repo,
      prompt,
      csrfToken: retryCsrfToken,
      idempotencyKey, // SAME key — dedupes a lost-response retry
    })

    if (retryResult.success) {
      return {kind: 'launched', runId: retryResult.data.runId}
    }

    // Second failure (any status) → generic failure, no further retry
    return {kind: 'failure'}
  }

  // Any other error (network, protocol, non-400/404/429 http) → failure
  return {kind: 'failure'}
}

// ---------------------------------------------------------------------------
// Pure: pending card hook descriptor
// ---------------------------------------------------------------------------

/**
 * Build the hook descriptor for an optimistic pending run card.
 *
 * Returns the runId and the CSS selectors needed to find the status element
 * and the shared stream-status notice element after the card is inserted.
 *
 * @param {string} runId
 * @returns {{runId: string, statusElSelector: string, noticeElSelector: string}} The hook descriptor.
 */
export function buildPendingCardHooks(runId) {
  return {
    runId,
    // Selector for the per-card run-status element (inside the card)
    statusElSelector: '[data-role="run-status"]',
    // Selector for the shared stream-status notice (in the run-status section)
    noticeElSelector: '[data-role="stream-status"]',
  }
}

// ---------------------------------------------------------------------------
// Pure: stream module specifier
// ---------------------------------------------------------------------------

/**
 * Returns the module specifier for operator-stream that includes ?manual=1.
 *
 * Using ?manual=1 ensures operator-stream's top-level auto-bootstrap guard
 * treats the import as a manual (React runtime) load and skips auto-bootstrap,
 * preventing double lifecycle ownership when launch imports stream.
 *
 * Exported so tests can assert the correct specifier without intercepting
 * dynamic imports.
 */
export function streamModuleSpecifier() {
  return '/static/operator-stream.js?manual=1'
}

// ---------------------------------------------------------------------------
// Pure: browser launch client builder
// ---------------------------------------------------------------------------

/**
 * Build a browser-direct launch client.
 *
 * Accepts an optional endpointBase (default: '/operator') so the runtime-loader
 * seam can configure a different endpoint base in dev mode without modifying
 * production behavior. The default is always '/operator'.
 *
 * Also accepts optional getScenario and fixtureSessionId for dev-mode launches.
 * These are included in the launch request body only when provided.
 *
 * Security:
 * - Never logs prompt, csrf, idempotency key, runId, or endpoint base.
 * - All 400s → one generic failure; 404 → one uniform unavailable.
 * - credentials:'include', redirect:'error' on all fetch calls.
 *
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.endpointBase] - The endpoint base path. Defaults to '/operator'.
 * @param {() => string} [opts.getScenario] - Fixture scenario source (fixture mode only).
 * @param {string} [opts.fixtureSessionId] - Fixture session ID (fixture mode only).
 * @returns {object} A client with refreshCsrf, listRepos, and launchRun methods.
 */
export function buildLaunchClient(opts) {
  const endpointBase = opts?.endpointBase ?? '/operator'
  const getScenario = opts?.getScenario
  const fixtureSessionId = opts?.fixtureSessionId

  const browserFetch = (input, init) =>
    globalThis.fetch(input, {
      ...init,
      credentials: 'include',
      redirect: 'error',
    })

  return {
    async refreshCsrf() {
      try {
        const res = await browserFetch(`${endpointBase}/session/csrf`, {
          headers: {'content-type': 'application/json'},
        })
        if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
        const data = await res.json()
        if (data === null || typeof data !== 'object' || typeof data.csrfToken !== 'string') {
          return {success: false, error: {kind: 'protocol', message: 'invalid csrf response'}}
        }
        return {success: true, data: {csrfToken: data.csrfToken}}
      } catch {
        return {success: false, error: {kind: 'network', message: 'network error'}}
      }
    },

    async listRepos() {
      try {
        const res = await browserFetch(`${endpointBase}/repos`, {
          headers: {'content-type': 'application/json'},
        })
        if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
        const data = await res.json()
        if (!Array.isArray(data)) {
          return {success: false, error: {kind: 'protocol', message: 'invalid repos response'}}
        }
        for (const item of data) {
          if (!validateRepoItem(item)) {
            return {success: false, error: {kind: 'protocol', message: 'invalid repos response'}}
          }
        }
        return {success: true, data}
      } catch {
        return {success: false, error: {kind: 'network', message: 'network error'}}
      }
    },

    async launchRun(req) {
      if (!req.csrfToken || req.csrfToken.trim() === '') {
        return {success: false, error: {kind: 'validation', code: 'missing_csrf', message: 'CSRF token required'}}
      }
      if (!req.idempotencyKey || req.idempotencyKey.trim() === '') {
        return {success: false, error: {kind: 'validation', code: 'missing_idempotency_key', message: 'Idempotency key required'}}
      }
      try {
        // Build the request body — include fixture fields only when provided.
        // getScenario() is called at submit time so scenario changes after init are reflected.
        const bodyObj = {repo: req.repo, prompt: req.prompt}
        const currentScenario = typeof getScenario === 'function' ? getScenario() : undefined
        if (currentScenario !== undefined) bodyObj.scenario = currentScenario
        if (fixtureSessionId !== undefined) bodyObj.fixtureSessionId = fixtureSessionId
        if (req.idempotencyKey !== undefined) bodyObj.idempotencyKey = req.idempotencyKey

        const res = await browserFetch(`${endpointBase}/runs`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': req.csrfToken,
            'idempotency-key': req.idempotencyKey,
          },
          body: JSON.stringify(bodyObj),
        })
        if (res.status === 200 || res.status === 202) {
          const data = await res.json()
          if (typeof data.runId !== 'string' || data.runId === '') {
            return {success: false, error: {kind: 'protocol', message: 'invalid runId in launch response'}}
          }
          return {success: true, data: {runId: data.runId}}
        }
        return {success: false, error: {kind: 'http', status: res.status}}
      } catch {
        return {success: false, error: {kind: 'network', message: 'network error'}}
      }
    },
  }
}

// ---------------------------------------------------------------------------
// DOM shell — only runs in a browser (document must exist)
// ---------------------------------------------------------------------------

// Module-level state: tracks whether initOperatorLaunch has been called and
// the AbortController used to remove the submit listener on reset.
// resetLaunchState() aborts the prior listener before clearing state.
// Declared here (before initOperatorLaunch) to satisfy no-use-before-define.
let _launchInitialized = false
let _launchAbortController = null
// Tracks the stream handle returned by initOperatorStream for launch-created runs.
// resetLaunchState() closes this handle to prevent leaked connections/timers.
let _launchStreamHandle = null

/**
 * Set the launch-created stream handle.
 *
 * Called internally by initOperatorLaunch after a successful launch to track
 * the stream handle so resetLaunchState() can close it. Exported for testing
 * so tests can inject a fake handle without calling the DOM-touching initOperatorLaunch.
 *
 * @param {{close(): void}} handle - The stream handle returned by initOperatorStream.
 */
export function setLaunchStreamHandle(handle) {
  _launchStreamHandle = handle
}

/**
 * Initialize the operator launch UI.
 *
 * Builds a browser client with credentials:'include', renders the repo picker
 * from listRepos(), wires the launch form submit, and on a successful launch
 * inserts an optimistic pending card and calls initOperatorStream directly.
 *
 * This function touches the DOM and must only be called from a browser context.
 * It is never called at module top-level, so Vitest can import this file safely.
 *
 * Security:
 * - Never logs prompt, csrf, idempotency key, or runId.
 * - Renders only safe fields; no error-copy that echoes sensitive values.
 * - runId appears only in data-run-id attribute and the stream URL (via initOperatorStream).
 * - All 400s → one generic failure message; 404 → one uniform unavailable message.
 */
export async function initOperatorLaunch(opts) {
  // Create an AbortController for this init session. The controller's signal is
  // passed to the submit event listener so that resetLaunchState() can abort it,
  // removing the listener without needing a reference to the handler function.
  // This prevents double-registration under React Strict Mode.
  const abortController = new AbortController()
  _launchAbortController = abortController

  const {initOperatorStream} = await import(streamModuleSpecifier())

  // Build the client using the optional endpointBase from opts.
  // Default is '/operator' (production path). Dev mode may pass a different base
  // through the runtime-loader seam.
  // These same-origin relative paths are owned by the public reverse proxy
  // (production) or the dev harness. The dashboard app deliberately
  // does NOT mount or proxy them — serving them here would make this read-only
  // app a credential-forwarding component.
  const client = buildLaunchClient(opts)

  // -------------------------------------------------------------------------
  // Render repo picker
  // -------------------------------------------------------------------------

  const pickerContainer = document.querySelector('#repo-picker-container')

  if (pickerContainer !== null) {
    const reposResult = await client.listRepos()

    if (!reposResult.success) {
      // Failure — classify into a neutral operator failure state.
      // Never render "No repositories available" for auth/rate-limit/network/protocol failures.
      // The copy is fixed and coarse — no raw error details, status codes, or paths.
      const error = reposResult.error
      let failureCopy
      if (error.kind === 'http') {
        const status = error.status ?? 0
        if (status === 401 || status === 403) {
          failureCopy = 'Sign in required to load repositories.'
        } else if (status === 429) {
          failureCopy = 'Repository list temporarily unavailable. Try again shortly.'
        } else {
          failureCopy = 'Repository list unavailable.'
        }
      } else if (error.kind === 'network') {
        failureCopy = 'Repository list unavailable \u2014 check your connection.'
      } else {
        // protocol or unknown
        failureCopy = 'Repository list unavailable.'
      }
      pickerContainer.textContent = failureCopy
    } else if (reposResult.data.length === 0) {
      // Successful fetch but empty list — this is the only case where "no repos" is accurate.
      pickerContainer.textContent = 'No repositories configured.'
    } else {
      // Render a <select> with the available repos
      const select = document.createElement('select')
      select.id = 'launch-repo-select'
      select.name = 'repo'
      select.setAttribute('aria-label', 'Select repository')
      select.style.cssText = 'width:100%;max-width:400px;padding:6px 10px;border:1px solid #d1d5db;border-radius:4px;font-size:0.875rem;'

      for (const repo of reposResult.data) {
        // Render only the safe owner/repo display string — no channelName or other fields
        const repoStr = `${repo.owner}/${repo.repo}`
        const option = document.createElement('option')
        option.value = repoStr
        option.textContent = repoStr
        select.append(option)
      }

      pickerContainer.textContent = ''
      pickerContainer.append(select)
    }
  }

  // -------------------------------------------------------------------------
  // Wire launch form submit
  // -------------------------------------------------------------------------

  const launchForm = document.querySelector('#launch-form')
  const launchError = document.querySelector('#launch-error')
  const runStatusSection = document.querySelector('#run-status-section')
  const sharedNoticeEl = runStatusSection?.querySelector('[data-role="stream-status"]') ?? null

  if (launchForm !== null) {
    // In-flight submit mutex: prevents double-launch even when requestSubmit()
    // bypasses the disabled button (e.g. DevTools or browser extensions).
    let launching = false

    launchForm.addEventListener('submit', async event => {
      event.preventDefault()

      // Mutex guard — re-entry is impossible regardless of how submit is triggered
      if (launching) return
      launching = true

      // Pre-fetch validation: empty prompt
      const formData = new FormData(launchForm)
      const prompt = (formData.get('prompt') ?? '').toString().trim()
      if (prompt === '') {
        launching = false
        if (launchError !== null) {
          launchError.textContent = 'Please enter a prompt before launching.'
          launchError.hidden = false
        }
        return
      }

      // Get selected repo from the select element (rendered by picker) or fallback
      const repoSelectEl = document.querySelector('#launch-repo-select')
      const repo = repoSelectEl?.value ?? formData.get('repo')?.toString() ?? ''
      if (repo === '') {
        launching = false
        if (launchError !== null) {
          launchError.textContent = 'Please select a repository.'
          launchError.hidden = false
        }
        return
      }

      // Clear previous error
      if (launchError !== null) {
        launchError.textContent = ''
        launchError.hidden = true
      }

      // Disable submit during in-flight request
      const submitBtn = launchForm.querySelector('[type="submit"]')
      if (submitBtn !== null) submitBtn.disabled = true

      // Mint a fresh idempotency key for this submission
      const idempotencyKey = mintIdempotencyKey()

      let outcome
      try {
        outcome = await submitLaunch(client, {repo, prompt}, idempotencyKey)
      } catch {
        // Unexpected throw (e.g. mintIdempotencyKey or submitLaunch itself throws) —
        // set generic failure copy so the form is never stuck.
        if (launchError !== null) {
          launchError.textContent = 'Launch failed. Please try again.'
          launchError.hidden = false
        }
        return
      } finally {
        // Always re-enable the button and clear the mutex, even on throw
        if (submitBtn !== null) submitBtn.disabled = false
        launching = false
      }

      if (outcome.kind === 'launched') {
        const {runId} = outcome

        // Insert an optimistic pending card into #run-status-section
        if (runStatusSection !== null) {
          const card = document.createElement('div')
          card.className = 'run-card'
          card.tabIndex = 0
          card.setAttribute('aria-label', 'New run, status: Pending')
          card.dataset.testid = 'run-card'
          card.dataset.runId = runId

          const statusSpan = document.createElement('span')
          statusSpan.className = 'run-status status-queued'
          statusSpan.dataset.role = 'run-status'
          statusSpan.textContent = 'Pending'

          card.append(statusSpan)
          runStatusSection.append(card)

          // Wire the SSE stream directly — do NOT re-run bootstrapOperatorStreams.
          // Store the returned handle so resetLaunchState() can close it on cleanup.
          const statusEl = card.querySelector('[data-role="run-status"]')
          const streamHandle = initOperatorStream({runId, statusEl, noticeEl: sharedNoticeEl, endpointBase: opts?.endpointBase})
          setLaunchStreamHandle(streamHandle)
        }

        // Reset the form
        launchForm.reset()
      } else if (outcome.kind === 'not-found') {
        if (launchError !== null) {
          launchError.textContent = 'The selected repository is not available for launch.'
          launchError.hidden = false
        }
      } else if (outcome.kind === 'rate-limited') {
        if (launchError !== null) {
          launchError.textContent = 'Too many launch requests. Please wait before trying again.'
          launchError.hidden = false
        }
      } else if (launchError !== null) {
        // failure — generic, no cause inference
        launchError.textContent = 'Launch failed. Please try again.'
        launchError.hidden = false
      }
    }, {signal: abortController.signal})
  }
}

/**
 * Reset the launch state.
 *
 * Aborts the AbortController that was passed to the submit event listener,
 * removing it from the form. Called by the React runtime seam cleanup so that
 * a remount (e.g. after auth expiry and re-login) can re-initialize the launch
 * UI without double-registering submit handlers. Also used in tests.
 */
export function resetLaunchState() {
  if (_launchAbortController !== null) {
    _launchAbortController.abort()
    _launchAbortController = null
  }
  // Close the launch-created stream handle to prevent leaked connections/timers.
  if (_launchStreamHandle !== null) {
    try {
      _launchStreamHandle.close()
    } catch {
      // ignore close errors
    }
    _launchStreamHandle = null
  }
  _launchInitialized = false
}

// Wrap initOperatorLaunch to be idempotent.
const _initOperatorLaunchOnce = async () => {
  if (_launchInitialized) return
  _launchInitialized = true
  await initOperatorLaunch()
}

// Auto-start in the browser. Guarded so a Node/test import never touches the DOM.
// When imported with ?manual=1 (by the React runtime seam), auto-start is skipped
// so the seam has deterministic lifecycle control. Normal /static/operator-launch.js
// loads (without ?manual=1) retain the legacy auto-start behavior.
if (typeof document !== 'undefined') {
  const isManual = (() => {
    try {
      return new URL(import.meta.url).searchParams.has('manual')
    } catch {
      return false
    }
  })()
  if (!isManual) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        _initOperatorLaunchOnce()
      })
    } else {
      _initOperatorLaunchOnce()
    }
  }
}
