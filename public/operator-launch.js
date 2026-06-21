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
 * @returns {PendingCardHooks} The hook descriptor with runId and element selectors.
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
// DOM shell — only runs in a browser (document must exist)
// ---------------------------------------------------------------------------

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
export async function initOperatorLaunch() {
  const {initOperatorStream} = await import('/static/operator-stream.js')

  // Browser fetch adapter: credentials:'include', redirect:'error'
  const browserFetch = (input, init) =>
    globalThis.fetch(input, {
      ...init,
      credentials: 'include',
      redirect: 'error',
    })

  // Minimal inline browser client — calls the gateway directly with credentials:'include'.
  const client = {
    async refreshCsrf() {
      try {
        const res = await browserFetch('/operator/session/csrf', {
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
        const res = await browserFetch('/operator/repos', {
          headers: {'content-type': 'application/json'},
        })
        if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
        const data = await res.json()
        if (!Array.isArray(data)) {
          return {success: false, error: {kind: 'protocol', message: 'invalid repos response'}}
        }
        // Validate each item — fail closed if any item is malformed.
        // A null or missing-field item would crash the picker render loop.
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
        const res = await browserFetch('/operator/runs', {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': req.csrfToken,
            'idempotency-key': req.idempotencyKey,
          },
          body: JSON.stringify({repo: req.repo, prompt: req.prompt}),
        })
        if (res.status === 202) {
          const data = await res.json()
          // Validate runId — a missing or non-string runId would produce a bogus stream URL
          if (typeof data.runId !== 'string' || data.runId === '') {
            return {success: false, error: {kind: 'protocol', message: 'invalid runId in 202 response'}}
          }
          return {success: true, data: {runId: data.runId}}
        }
        return {success: false, error: {kind: 'http', status: res.status}}
      } catch {
        return {success: false, error: {kind: 'network', message: 'network error'}}
      }
    },
  }

  // -------------------------------------------------------------------------
  // Render repo picker
  // -------------------------------------------------------------------------

  const pickerContainer = document.querySelector('#repo-picker-container')

  if (pickerContainer !== null) {
    const reposResult = await client.listRepos()

    if (!reposResult.success || reposResult.data.length === 0) {
      pickerContainer.textContent = 'No repositories available.'
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
          card.dataset.runId = runId

          const statusSpan = document.createElement('span')
          statusSpan.className = 'run-status status-queued'
          statusSpan.dataset.role = 'run-status'
          statusSpan.textContent = 'Pending'

          card.append(statusSpan)
          runStatusSection.append(card)

          // Wire the SSE stream directly — do NOT re-run bootstrapOperatorStreams
          const statusEl = card.querySelector('[data-role="run-status"]')
          initOperatorStream({runId, statusEl, noticeEl: sharedNoticeEl})
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
    })
  }
}

// Auto-start in the browser. Guarded so a Node/test import never touches the DOM.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initOperatorLaunch()
    })
  } else {
    initOperatorLaunch()
  }
}
