/**
 * Typed Gateway operator API client contract tests.
 *
 * These tests prove the mocked boundary contract only; no live /operator/* calls.
 *
 * Security invariants tested:
 * - Sensitive values (prompts, tool args, workspace paths, tokens, session IDs,
 *   CSRF values, internal URLs) are never logged.
 * - Mutating calls reject before fetch when CSRF token or idempotency key is
 *   missing or blank.
 * - Fetch wrapper rejects absolute URLs.
 * - SSE transport sends Last-Event-ID header when provided.
 */

import type {
  LaunchRunRequest,
  OperatorClientOptions,
  RunStreamEvent,
} from '../src/gateway/operator-client.ts'
import {describe, expect, it} from 'vitest'
import {createOperatorClient, validateOperatorPath} from '../src/gateway/operator-client.ts'

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeOkFetch(body: unknown, status = 200): OperatorClientOptions['fetch'] {
  return async (_input, _init) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    })
}

function makeErrorFetch(status: number): OperatorClientOptions['fetch'] {
  return async (_input, _init) =>
    new Response(JSON.stringify({error: 'gateway_error', message: 'test error'}), {
      status,
      headers: {'content-type': 'application/json'},
    })
}

type StreamEventCallback = (event: RunStreamEvent) => void

function makeEventStream(events: RunStreamEvent[]): OperatorClientOptions['createEventStream'] {
  return (_path, _opts) => {
    return {
      start(onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
        for (const event of events) {
          onEvent(event)
        }
        onClose()
      },
      close() {},
    }
  }
}

// ---------------------------------------------------------------------------
// getCurrentSession
// ---------------------------------------------------------------------------

describe('getCurrentSession', () => {
  it('returns session data on success', async () => {
    const sessionData = {
      operatorId: 42,
      login: 'octocat',
      expiresAt: 4070908800000,
    }
    const client = createOperatorClient({
      fetch: makeOkFetch(sessionData),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.operatorId).toBe(42)
      expect(result.data.login).toBe('octocat')
    }
  })

  it('returns error on 401', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(401),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(401)
      }
    }
  })

  it('returns protocol error when expiresAt is a string (legacy shape)', async () => {
    // Canonical OperatorSessionInfo.expiresAt is number; string must fail parse
    const legacyShape = {operatorId: 42, login: 'octocat', expiresAt: '2026-06-18T22:00:00Z'}
    const client = createOperatorClient({
      fetch: makeOkFetch(legacyShape),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('uses relative path /operator/session', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify({operatorId: 1, login: 'x', expiresAt: 4070908800000}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.getCurrentSession()
    expect(calls[0]).toBe('/operator/session')
  })
})

// ---------------------------------------------------------------------------
// refreshCsrf
// ---------------------------------------------------------------------------

describe('refreshCsrf', () => {
  it('returns csrf token on success', async () => {
    const csrfData = {csrfToken: 'csrf-abc123'}
    const client = createOperatorClient({
      fetch: makeOkFetch(csrfData),
      createEventStream: makeEventStream([]),
    })
    const result = await client.refreshCsrf()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.csrfToken).toBe('csrf-abc123')
    }
  })

  it('rejects old {token, expiresAt} shape as protocol error', async () => {
    // Canonical field is csrfToken (not token); old shape must fail parse
    const oldShape = {token: 'csrf-abc123', expiresAt: '2026-06-18T22:00:00Z'}
    const client = createOperatorClient({
      fetch: makeOkFetch(oldShape),
      createEventStream: makeEventStream([]),
    })
    const result = await client.refreshCsrf()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('uses relative path /operator/session/csrf', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify({csrfToken: 't'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.refreshCsrf()
    expect(calls[0]).toBe('/operator/session/csrf')
  })
})

// ---------------------------------------------------------------------------
// launchRun — CSRF + idempotency key guards
// ---------------------------------------------------------------------------

describe('launchRun', () => {
  const validRequest: LaunchRunRequest = {
    repo: 'owner/repo',
    prompt: 'fix the bug',
    idempotencyKey: 'idem-key-abc',
    csrfToken: 'csrf-token-xyz',
  }

  it('returns runId on success (202 wire shape)', async () => {
    const runData = {runId: 'run-xyz'}
    const client = createOperatorClient({
      fetch: makeOkFetch(runData, 202),
      createEventStream: makeEventStream([]),
    })
    const result = await client.launchRun(validRequest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runId).toBe('run-xyz')
    }
  })

  it('sends body with only repo and prompt — no csrf or idempotency in body', async () => {
    let capturedBody: unknown
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return new Response(JSON.stringify({runId: 'run-xyz'}), {
          status: 202,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun({repo: 'owner/repo', prompt: 'p', csrfToken: 'csrf-token-xyz', idempotencyKey: 'idem-key-abc'})
    expect(capturedBody).toEqual({repo: 'owner/repo', prompt: 'p'})
  })

  it('rejects before fetch when csrfToken is blank — fetchCalled is false', async () => {
    let fetchCalled = false
    const neverFetch: OperatorClientOptions['fetch'] = async () => {
      fetchCalled = true
      return new Response('', {status: 200})
    }
    const client = createOperatorClient({
      fetch: neverFetch,
      createEventStream: makeEventStream([]),
    })
    const req = {...validRequest, csrfToken: ''}
    const result = await client.launchRun(req)
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_csrf')
      }
    }
  })

  it('rejects before fetch when idempotencyKey is blank — fetchCalled is false', async () => {
    let fetchCalled = false
    const neverFetch: OperatorClientOptions['fetch'] = async () => {
      fetchCalled = true
      return new Response('', {status: 200})
    }
    const client = createOperatorClient({
      fetch: neverFetch,
      createEventStream: makeEventStream([]),
    })
    const req = {...validRequest, idempotencyKey: ''}
    const result = await client.launchRun(req)
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_idempotency_key')
      }
    }
  })

  it('rejects before fetch when csrfToken is whitespace-only', async () => {
    let fetchCalled = false
    const neverFetch: OperatorClientOptions['fetch'] = async () => {
      fetchCalled = true
      return new Response('', {status: 200})
    }
    const client = createOperatorClient({
      fetch: neverFetch,
      createEventStream: makeEventStream([]),
    })
    const req = {...validRequest, csrfToken: '   '}
    const result = await client.launchRun(req)
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
  })

  it('uses relative path /operator/runs', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify({runId: 'r1'}), {
          status: 202,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun(validRequest)
    expect(calls[0]).toBe('/operator/runs')
  })

  it('sends x-csrf-token header with csrfToken value', async () => {
    const headers: Record<string, string> = {}
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        const h = init?.headers as Record<string, string> | undefined
        if (h) Object.assign(headers, h)
        return new Response(JSON.stringify({runId: 'r1'}), {
          status: 202,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun(validRequest)
    expect(headers['x-csrf-token']).toBe('csrf-token-xyz')
  })

  it('sends idempotency-key header with idempotencyKey value', async () => {
    const headers: Record<string, string> = {}
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        const h = init?.headers as Record<string, string> | undefined
        if (h) Object.assign(headers, h)
        return new Response(JSON.stringify({runId: 'r1'}), {
          status: 202,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun(validRequest)
    expect(headers['idempotency-key']).toBe('idem-key-abc')
  })

  it('maps 400 response to http error with status 400', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(400),
      createEventStream: makeEventStream([]),
    })
    const result = await client.launchRun(validRequest)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(400)
      }
    }
  })

  it('maps 404 response to http error with status 404', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
    })
    const result = await client.launchRun(validRequest)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(404)
      }
    }
  })

  it('maps 429 response to http error with status 429', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(429),
      createEventStream: makeEventStream([]),
    })
    const result = await client.launchRun(validRequest)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(429)
      }
    }
  })

  it('does not log prompt value in any log entry', async () => {
    const loggedMessages: string[] = []
    const capturingLogger = {
      info: (msg: string) => loggedMessages.push(msg),
      error: (msg: string) => loggedMessages.push(msg),
      warning: (msg: string) => loggedMessages.push(msg),
      debug: (msg: string) => loggedMessages.push(msg),
    }
    const client = createOperatorClient({
      fetch: makeErrorFetch(400),
      createEventStream: makeEventStream([]),
      logger: capturingLogger,
    })
    await client.launchRun({...validRequest, prompt: 'SECRET_PROMPT_VALUE'})
    const allLogged = loggedMessages.join(' ')
    expect(allLogged).not.toContain('SECRET_PROMPT_VALUE')
  })

  it('route template logged is /operator/runs only (no dynamic segments)', async () => {
    const loggedMeta: Record<string, unknown>[] = []
    const capturingLogger = {
      info: (_msg: string, meta?: Record<string, unknown>) => { if (meta) loggedMeta.push(meta) },
      error: (_msg: string, meta?: Record<string, unknown>) => { if (meta) loggedMeta.push(meta) },
      warning: (_msg: string, meta?: Record<string, unknown>) => { if (meta) loggedMeta.push(meta) },
      debug: (_msg: string, meta?: Record<string, unknown>) => { if (meta) loggedMeta.push(meta) },
    }
    const client = createOperatorClient({
      fetch: makeErrorFetch(400),
      createEventStream: makeEventStream([]),
      logger: capturingLogger,
    })
    await client.launchRun(validRequest)
    for (const meta of loggedMeta) {
      if (meta.route !== undefined) {
        expect(meta.route).toBe('/operator/runs')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// getRunSnapshot
// ---------------------------------------------------------------------------

describe('getRunSnapshot', () => {
  it('returns run snapshot on success', async () => {
    const snapshot = {
      runId: 'run-001',
      status: 'running' as const,
      owner: 'fro-bot',
      repo: 'agent',
      createdAt: '2026-06-18T20:00:00Z',
    }
    const client = createOperatorClient({
      fetch: makeOkFetch(snapshot),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('run-001')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runId).toBe('run-001')
      expect(result.data.status).toBe('running')
    }
  })

  it('uses relative path /operator/runs/:runId', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(
          JSON.stringify({runId: 'run-42', status: 'queued', owner: 'o', repo: 'r', createdAt: '2026-06-18T20:00:00Z'}),
          {status: 200, headers: {'content-type': 'application/json'}},
        )
      },
      createEventStream: makeEventStream([]),
    })
    await client.getRunSnapshot('run-42')
    expect(calls[0]).toBe('/operator/runs/run-42')
  })

  it('returns error on 404', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('run-missing')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(404)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// connectRunStream — SSE transport
// ---------------------------------------------------------------------------

describe('connectRunStream', () => {
  it('delivers typed events to the callback', () => {
    const events: RunStreamEvent[] = [
      {type: 'ready', data: {contractVersion: '1.1.0'}},
      {
        type: 'status',
        data: {
          runId: 'run-001',
          entityRef: 'fro-bot/agent',
          surface: 'github',
          phase: 'EXECUTING',
          status: 'running',
          startedAt: '2026-06-18T20:00:00Z',
          stale: false,
        },
      },
    ]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received).toHaveLength(2)
    expect(received[0]?.type).toBe('ready')
    expect(received[1]?.type).toBe('status')
  })

  it('passes lastEventId to the transport', () => {
    const capturedOpts: {lastEventId?: string}[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, opts) => {
        capturedOpts.push(opts ?? {})
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
      lastEventId: 'evt-99',
    })
    expect(capturedOpts[0]?.lastEventId).toBe('evt-99')
  })

  it('uses relative path /operator/runs/:runId/stream', () => {
    const capturedPaths: string[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (path, _opts) => {
        capturedPaths.push(path)
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(capturedPaths[0]).toBe('/operator/runs/run-001/stream')
  })

  it('delivers reset event when stream is reset', () => {
    const events: RunStreamEvent[] = [{type: 'reset', data: {runId: 'run-001', reason: 'no-snapshot'}}]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
  })

  it('delivers status events for terminal run statuses', () => {
    const terminalStatuses = ['succeeded', 'failed', 'cancelled'] as const
    for (const status of terminalStatuses) {
      const events: RunStreamEvent[] = [
        {
          type: 'status',
          data: {
            runId: 'run-001',
            entityRef: 'fro-bot/agent',
            surface: 'github',
            phase: 'COMPLETED',
            status,
            startedAt: '2026-06-18T20:00:00Z',
            stale: false,
          },
        },
      ]
      const received: RunStreamEvent[] = []
      const client = createOperatorClient({
        fetch: makeOkFetch({}),
        createEventStream: makeEventStream(events),
      })
      client.connectRunStream('run-001', {
        onEvent: e => received.push(e),
        onError: () => {},
        onClose: () => {},
      })
      expect(received[0]?.type).toBe('status')
      if (received[0]?.type === 'status') {
        expect(received[0].data.status).toBe(status)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// listRunApprovals — 1.4.0 per-run GET
// ---------------------------------------------------------------------------

describe('listRunApprovals', () => {
  it('returns open approvals list on success', async () => {
    const approvals = [
      {
        requestID: 'req-001',
        permission: 'tool_use',
        command: 'bash',
      },
    ]
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('run-001')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.approvals).toHaveLength(1)
      expect(result.data.approvals[0]?.requestID).toBe('req-001')
      expect(result.data.approvals[0]?.permission).toBe('tool_use')
    }
  })

  it('uses relative path /operator/runs/:runId/approvals', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify({approvals: []}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.listRunApprovals('run-001')
    expect(calls[0]).toBe('/operator/runs/run-001/approvals')
  })

  it('returns empty approvals array when no open prompts', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals: []}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('run-001')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.approvals).toHaveLength(0)
    }
  })

  it('returns approval with optional filepath field', async () => {
    const approvals = [{requestID: 'req-001', permission: 'file_write', filepath: '/tmp/out.txt'}]
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('run-001')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.approvals[0]?.filepath).toBe('/tmp/out.txt')
    }
  })

  it('returns approval with neither command nor filepath (bare permission)', async () => {
    const approvals = [{requestID: 'req-001', permission: 'network_access'}]
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('run-001')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.approvals[0]?.command).toBeUndefined()
      expect(result.data.approvals[0]?.filepath).toBeUndefined()
    }
  })

  it('rejects blank runId before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response(JSON.stringify({approvals: []}), {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('returns http error on 404', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('run-missing')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(404)
      }
    }
  })

  it('returns network error when fetch throws', async () => {
    const client = createOperatorClient({
      fetch: async () => { throw new Error('ECONNREFUSED') },
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRunApprovals('run-001')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
    }
  })
})

// ---------------------------------------------------------------------------
// decideRunApproval — 1.4.0 per-run POST with once/always/reject verbs
// ---------------------------------------------------------------------------

describe('decideRunApproval', () => {
  it('returns claimed state on success with once verb', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'claimed'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-decision-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('claimed')
    }
  })

  it('returns claimed state on success with always verb', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'claimed'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'always', 'idem-decision-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('claimed')
    }
  })

  it('returns claimed state on success with reject verb', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'claimed'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'reject', 'idem-decision-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('claimed')
    }
  })

  it('uses relative path /operator/runs/:runId/approvals/:requestId/decision', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify({state: 'claimed'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(calls[0]).toBe('/operator/runs/run-001/approvals/req-001/decision')
  })

  it('sends decision verb in request body', async () => {
    let capturedBody: unknown
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return new Response(JSON.stringify({state: 'claimed'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideRunApproval('run-001', 'req-001', 'always', 'idem-key-abc', 'csrf-token-xyz')
    expect(capturedBody).toEqual({decision: 'always'})
  })

  it('sends x-csrf-token header', async () => {
    const headers: Record<string, string> = {}
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        const h = init?.headers as Record<string, string> | undefined
        if (h) Object.assign(headers, h)
        return new Response(JSON.stringify({state: 'claimed'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(headers['x-csrf-token']).toBe('csrf-token-xyz')
  })

  it('sends idempotency-key header', async () => {
    const headers: Record<string, string> = {}
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        const h = init?.headers as Record<string, string> | undefined
        if (h) Object.assign(headers, h)
        return new Response(JSON.stringify({state: 'claimed'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(headers['idempotency-key']).toBe('idem-key-abc')
  })

  it('passes redirect: error in fetch init', async () => {
    let capturedInit: RequestInit | undefined
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        capturedInit = init
        return new Response(JSON.stringify({state: 'claimed'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(capturedInit?.redirect).toBe('error')
  })

  it('rejects before fetch when csrfToken is blank', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', '')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_csrf')
      }
    }
  })

  it('rejects before fetch when csrfToken is whitespace-only', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', '   ')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_csrf')
      }
    }
  })

  it('rejects before fetch when idempotencyKey is blank', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', '', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_idempotency_key')
      }
    }
  })

  it('rejects before fetch when idempotencyKey is whitespace-only', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', '   ', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_idempotency_key')
      }
    }
  })

  it('rejects before fetch when runId is blank', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('rejects before fetch when requestId is blank', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', '', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  // Approval decision failure classes: denial-404 vs transport-error vs already-settled state values

  it('404 response surfaces as denial-class http error (distinct from network throw)', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(404)
      }
    }
  })

  it('network throw surfaces as transport-error (distinct from 404 denial)', async () => {
    const client = createOperatorClient({
      fetch: async () => { throw new Error('ECONNREFUSED') },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
    }
  })

  it('404 and network throw are distinguishable (different error kinds)', async () => {
    const clientDenial = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
    })
    const clientTransport = createOperatorClient({
      fetch: async () => { throw new Error('ECONNREFUSED') },
      createEventStream: makeEventStream([]),
    })
    const denialResult = await clientDenial.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    const transportResult = await clientTransport.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(denialResult.success).toBe(false)
    expect(transportResult.success).toBe(false)
    if (!denialResult.success && !transportResult.success) {
      expect(denialResult.error.kind).toBe('http')
      expect(transportResult.error.kind).toBe('network')
      expect(denialResult.error.kind).not.toBe(transportResult.error.kind)
    }
  })

  it('already_claimed state is returned to caller (not thrown)', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'already_claimed'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('already_claimed')
    }
  })

  it('unavailable state is returned to caller', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'unavailable'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('unavailable')
    }
  })

  it('scope_mismatch state is returned to caller', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'scope_mismatch'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('scope_mismatch')
    }
  })

  it('failed_to_settle state is returned to caller', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({state: 'failed_to_settle'}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('failed_to_settle')
    }
  })

  // CSRF-400 retry: retried once reusing the SAME idempotency key

  it('retries once on CSRF-400 reusing the same idempotency key', async () => {
    const capturedKeys: string[] = []
    let callCount = 0
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        callCount++
        const h = init?.headers as Record<string, string> | undefined
        const idemKey = h?.['idempotency-key']
        if (idemKey !== undefined && idemKey !== '') capturedKeys.push(idemKey)
        if (callCount === 1) {
          return new Response(JSON.stringify({error: 'csrf_invalid'}), {
            status: 400,
            headers: {'content-type': 'application/json'},
          })
        }
        return new Response(JSON.stringify({state: 'claimed'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-retry-test', 'csrf-token-xyz')
    expect(result.success).toBe(true)
    expect(callCount).toBe(2)
    // Both calls must use the SAME idempotency key
    expect(capturedKeys).toHaveLength(2)
    expect(capturedKeys[0]).toBe('idem-key-retry-test')
    expect(capturedKeys[1]).toBe('idem-key-retry-test')
  })

  it('does not retry a second time on second 400 (no third attempt)', async () => {
    let callCount = 0
    const client = createOperatorClient({
      fetch: async () => {
        callCount++
        return new Response(JSON.stringify({error: 'csrf_invalid'}), {
          status: 400,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    expect(callCount).toBe(2) // exactly 2: initial + one retry
  })

  it('does not retry on non-400 errors (404 is not retried)', async () => {
    let callCount = 0
    const client = createOperatorClient({
      fetch: async () => {
        callCount++
        return new Response(JSON.stringify({error: 'not_found'}), {
          status: 404,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(result.success).toBe(false)
    expect(callCount).toBe(1) // no retry for 404
  })

  it('does not log dynamic runId or requestId in error context', async () => {
    const loggedContexts: Record<string, unknown>[] = []
    const sensitiveRunId = 'SENSITIVE_RUN_ID_DECIDE_TEST'
    const sensitiveReqId = 'SENSITIVE_REQ_ID_DECIDE_TEST'
    const client = createOperatorClient({
      fetch: makeErrorFetch(409),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        info: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        warning: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        error: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
      },
    })
    await client.decideRunApproval(sensitiveRunId, sensitiveReqId, 'once', 'idem-key-abc', 'csrf-token-xyz')
    const allLogged = JSON.stringify(loggedContexts)
    expect(allLogged).not.toContain(sensitiveRunId)
    expect(allLogged).not.toContain(sensitiveReqId)
  })
})

// ---------------------------------------------------------------------------
// listRepos
// ---------------------------------------------------------------------------

describe('listRepos', () => {
  it('returns parsed repo list on success', async () => {
    const repos = [
      {owner: 'fro-bot', repo: 'agent'},
      {owner: 'x', repo: 'y', channelName: 'z'},
    ]
    const client = createOperatorClient({
      fetch: makeOkFetch(repos),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.owner).toBe('fro-bot')
      expect(result.data[0]?.repo).toBe('agent')
      expect(result.data[1]?.channelName).toBe('z')
    }
  })

  it('uses relative path /operator/repos', async () => {
    const capturedPaths: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        capturedPaths.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.listRepos()
    expect(capturedPaths[0]).toBe('/operator/repos')
  })

  it('returns ok with empty array when response is []', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch([]),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(0)
    }
  })

  it('returns protocol error when response is a non-array object', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('returns protocol error and no partial list when an item is missing repo field', async () => {
    // [{owner:'a'}] is missing required repo — whole list must fail closed
    const client = createOperatorClient({
      fetch: makeOkFetch([{owner: 'a'}]),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('returns http error on 401', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(401),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(401)
      }
    }
  })

  it('returns http error on 429', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(429),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(429)
      }
    }
  })

  it('returns http error on 503', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(503),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listRepos()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(503)
      }
    }
  })

  it('does not log repo owner or name in any log entry', async () => {
    const loggedEntries: {message: string; meta: Record<string, unknown>}[] = []
    const capturingLogger = {
      info: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
      warning: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
      debug: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
    }
    const repos = [{owner: 'secret-owner', repo: 'secret-repo'}]
    const client = createOperatorClient({
      fetch: makeOkFetch(repos),
      createEventStream: makeEventStream([]),
      logger: capturingLogger,
    })
    await client.listRepos()

    // Verify no log entry contains the owner or repo name
    for (const entry of loggedEntries) {
      const serialized = JSON.stringify(entry)
      expect(serialized).not.toContain('secret-owner')
      expect(serialized).not.toContain('secret-repo')
    }
  })

  it('does not log repo owner or name when parse fails', async () => {
    const loggedEntries: {message: string; meta: Record<string, unknown>}[] = []
    const capturingLogger = {
      info: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
      warning: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
      debug: (message: string, meta?: Record<string, unknown>) => {
        loggedEntries.push({message, meta: meta ?? {}})
      },
    }
    // Malformed item — parse will fail; logger must not echo the input
    const client = createOperatorClient({
      fetch: makeOkFetch([{owner: 'secret-owner'}]),
      createEventStream: makeEventStream([]),
      logger: capturingLogger,
    })
    await client.listRepos()

    for (const entry of loggedEntries) {
      const serialized = JSON.stringify(entry)
      expect(serialized).not.toContain('secret-owner')
    }
  })
})

// (Weak absolute-URL happy-path integration test removed — covered by validateOperatorPath unit tests below)

// ---------------------------------------------------------------------------
// Path parameter encoding
// ---------------------------------------------------------------------------

describe('path parameter encoding', () => {
  it('rejects runId with literal slash in getRunSnapshot before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('run/evil')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('rejects runId with percent-encoded slash (%2F) in getRunSnapshot before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('run%2Fevil')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('rejects runId with percent-encoded traversal (%2F..%2F) in getRunSnapshot before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('run%2Fevil%2F..%2Finject')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
  })

  it('rejects runId with percent-encoded backslash (%5C) in getRunSnapshot before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('run%5Cevil')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
  })

  it('encodes runId with query chars in getRunSnapshot', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(
          JSON.stringify({runId: 'run?x=1', status: 'queued', owner: 'o', repo: 'r', createdAt: '2026-06-18T20:00:00Z'}),
          {status: 200, headers: {'content-type': 'application/json'}},
        )
      },
      createEventStream: makeEventStream([]),
    })
    await client.getRunSnapshot('run?x=1')
    expect(calls[0]).toBe('/operator/runs/run%3Fx%3D1')
  })

  it('rejects runId with literal slash in connectRunStream before stream creation', () => {
    let streamCreated = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    const result = client.connectRunStream('run/evil', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(streamCreated).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('rejects runId with traversal (run/evil/../inject) in connectRunStream before stream creation', () => {
    let streamCreated = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    const result = client.connectRunStream('run/evil/../inject', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(streamCreated).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
  })

  it('rejects runId with percent-encoded slash (%2F) in connectRunStream before stream creation', () => {
    let streamCreated = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    const result = client.connectRunStream('run%2Fevil%2F..%2Finject', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(streamCreated).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
  })

  it('rejects requestId with literal slash in decideRunApproval before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req/evil', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  it('rejects requestId with percent-encoded slash (%2F) in decideRunApproval before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req%2Fevil', 'once', 'idem-key-abc', 'csrf-token-xyz')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  it('rejects requestId with percent-encoded backslash (%5C) in decideRunApproval before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideRunApproval('run-001', 'req%5Cevil', 'reject', 'idem-key-abc', 'csrf-token-xyz')
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
  })

  it('encodes requestId with query chars in decideRunApproval', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(
          JSON.stringify({state: 'claimed'}),
          {status: 200, headers: {'content-type': 'application/json'}},
        )
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideRunApproval('run-001', 'req?x=1', 'reject', 'idem-key-abc', 'csrf-token-xyz')
    expect(calls[0]).toBe('/operator/runs/run-001/approvals/req%3Fx%3D1/decision')
  })
})

// ---------------------------------------------------------------------------
// decideRunApproval — all OperatorDecisionState values
// ---------------------------------------------------------------------------

describe('decideRunApproval — all decision states', () => {
  // Canonical OperatorDecisionState values per contract v1.4.0
  const allStates = ['pending', 'claimed', 'already_claimed', 'scope_mismatch', 'failed_to_settle', 'unavailable'] as const

  for (const state of allStates) {
    it(`handles ${state} state`, async () => {
      const client = createOperatorClient({
        fetch: makeOkFetch({state}),
        createEventStream: makeEventStream([]),
      })
      const result = await client.decideRunApproval('run-001', 'req-state-test', 'once', 'idem-state-abc', 'csrf-state-xyz')
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.state).toBe(state)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// connectRunStream — all reset reasons
// ---------------------------------------------------------------------------

describe('connectRunStream — reset reasons', () => {
  it('delivers reset with no-snapshot reason', () => {
    const events: RunStreamEvent[] = [{type: 'reset', data: {runId: 'run-001', reason: 'no-snapshot'}}]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
    if (received[0]?.type === 'reset') {
      expect(received[0].data.reason).toBe('no-snapshot')
    }
  })

  it('delivers reset with terminal reason', () => {
    const events: RunStreamEvent[] = [{type: 'reset', data: {runId: 'run-001', reason: 'terminal'}}]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
    if (received[0]?.type === 'reset') {
      expect(received[0].data.reason).toBe('terminal')
    }
  })

  it('delivers reset with shutdown reason', () => {
    const events: RunStreamEvent[] = [{type: 'reset', data: {runId: 'run-001', reason: 'shutdown'}}]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
    if (received[0]?.type === 'reset') {
      expect(received[0].data.reason).toBe('shutdown')
    }
  })

  it('delivers reset with overflow reason', () => {
    const events: RunStreamEvent[] = [{type: 'reset', data: {runId: 'run-001', reason: 'overflow'}}]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
    if (received[0]?.type === 'reset') {
      expect(received[0].data.reason).toBe('overflow')
    }
  })
})

// ---------------------------------------------------------------------------
// Finding 1: Path validation — allowlist /operator/* only
// ---------------------------------------------------------------------------

describe('path validation — allowlist /operator/* only', () => {
  // The client constructs all paths internally, so we test via a minimal
  // test-seam: a custom createEventStream that receives the constructed path.
  // For fetchJson paths, we verify via a custom fetch that records the path
  // and that the guard fires before fetch for scheme-like injections.

  it('rejects file: scheme in path via getRunSnapshot', () => {
    // Since public methods construct paths internally, we test the path guard
    // via the exported validateOperatorPath seam.
    const result = validateOperatorPath('file:///etc/passwd')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects data: scheme', () => {
    const result = validateOperatorPath('data:text/html,<script>alert(1)</script>')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects blob: scheme', () => {
    const result = validateOperatorPath('blob:https://example.com/uuid')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects ftp: scheme', () => {
    const result = validateOperatorPath('ftp://evil.example.com/path')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects protocol-relative //...', () => {
    const result = validateOperatorPath('//evil.example.com/operator/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects non-operator relative path /session', () => {
    const result = validateOperatorPath('/session')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects non-operator relative path /admin/operator/runs', () => {
    const result = validateOperatorPath('/admin/operator/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('accepts /operator/session', () => {
    const result = validateOperatorPath('/operator/session')
    expect(result).toBeNull()
  })

  it('accepts /operator/runs/run-001', () => {
    const result = validateOperatorPath('/operator/runs/run-001')
    expect(result).toBeNull()
  })

  it('accepts /operator/runs/run-001/approvals (per-run approval route)', () => {
    const result = validateOperatorPath('/operator/runs/run-001/approvals')
    expect(result).toBeNull()
  })

  it('rejects http:// absolute URL via fetchJson path guard', async () => {
    // This is the existing guard — verify it still returns invalid_path
    const result = validateOperatorPath('http://evil.example.com/operator/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects https:// absolute URL', () => {
    const result = validateOperatorPath('https://evil.example.com/operator/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })
})

// ---------------------------------------------------------------------------
// Finding 2: Blank dynamic IDs must reject before fetch/stream creation
// ---------------------------------------------------------------------------

describe('getRunSnapshot — blank runId validation', () => {
  it('rejects blank runId before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('rejects whitespace-only runId before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getRunSnapshot('   ')
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })
})

describe('connectRunStream — blank runId validation', () => {
  it('rejects blank runId before stream creation', () => {
    let streamCreated = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    const result = client.connectRunStream('', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(streamCreated).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('rejects whitespace-only runId before stream creation', () => {
    let streamCreated = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {
          start(_onEvent: StreamEventCallback, _onError: (err: Error) => void, onClose: () => void) {
            onClose()
          },
          close() {},
        }
      },
    })
    const result = client.connectRunStream('   ', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(streamCreated).toBe(false)
    expect(result.success).toBe(false)
  })
})

// (decideRunApproval blank requestId/runId validation is tested inline in the decideRunApproval describe block above)

// ---------------------------------------------------------------------------
// Finding 3: SSE resume contract — event metadata with eventId
// ---------------------------------------------------------------------------

describe('connectRunStream — SSE event metadata (eventId)', () => {
  it('delivers eventId from stream to onEvent callback via meta parameter', () => {
    // The injectable stream must be able to pass eventId via meta
    const receivedMeta: {eventId?: string}[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => ({
        start(
          onEvent: (event: RunStreamEvent, meta?: {eventId?: string}) => void,
          _onError: (err: Error) => void,
          onClose: () => void,
        ) {
          onEvent({type: 'ready', data: {contractVersion: '1.1.0'}}, {eventId: 'evt-001'})
          onEvent(
            {
              type: 'status',
              data: {
                runId: 'run-001',
                entityRef: 'fro-bot/agent',
                surface: 'github',
                phase: 'EXECUTING',
                status: 'running',
                startedAt: '2026-06-18T20:00:00Z',
                stale: false,
              },
            },
            {eventId: 'evt-002'},
          )
          onClose()
        },
        close() {},
      }),
    })
    const receivedEvents: RunStreamEvent[] = []
    client.connectRunStream('run-001', {
      onEvent: (event, meta) => {
        receivedEvents.push(event)
        receivedMeta.push(meta ?? {})
      },
      onError: () => {},
      onClose: () => {},
    })
    expect(receivedEvents).toHaveLength(2)
    expect(receivedMeta[0]?.eventId).toBe('evt-001')
    expect(receivedMeta[1]?.eventId).toBe('evt-002')
  })

  it('delivers undefined eventId when stream does not provide one', () => {
    const receivedMeta: {eventId?: string}[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream([{type: 'ready', data: {contractVersion: '1.1.0'}}]),
    })
    client.connectRunStream('run-001', {
      onEvent: (_event, meta) => {
        receivedMeta.push(meta ?? {})
      },
      onError: () => {},
      onClose: () => {},
    })
    expect(receivedMeta).toHaveLength(1)
    // eventId should be undefined when not provided
    expect(receivedMeta[0]?.eventId).toBeUndefined()
  })

  it('client can receive eventId and pass it as lastEventId on reconnect', () => {
    // Simulate: first stream delivers events with IDs, client captures last ID,
    // then reconnects passing that ID as lastEventId.
    let lastCapturedEventId: string | undefined
    const capturedLastEventIds: (string | undefined)[] = []

    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, opts) => {
        capturedLastEventIds.push(opts?.lastEventId)
        return {
          start(
            onEvent: (event: RunStreamEvent, meta?: {eventId?: string}) => void,
            _onError: (err: Error) => void,
            onClose: () => void,
          ) {
            onEvent({type: 'ready', data: {contractVersion: '1.1.0'}}, {eventId: 'evt-100'})
            onClose()
          },
          close() {},
        }
      },
    })

    // First connection — capture the eventId
    client.connectRunStream('run-001', {
      onEvent: (_event, meta) => {
        if (meta?.eventId !== undefined) lastCapturedEventId = meta.eventId
      },
      onError: () => {},
      onClose: () => {},
    })

    expect(lastCapturedEventId).toBe('evt-100')

    // Second connection — pass the captured eventId as lastEventId
    client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
      lastEventId: lastCapturedEventId,
    })

    expect(capturedLastEventIds[0]).toBeUndefined() // first connection had no lastEventId
    expect(capturedLastEventIds[1]).toBe('evt-100') // second connection passes it
  })
})

// ---------------------------------------------------------------------------
// Sensitive value redaction — logger must not receive raw sensitive fields
// ---------------------------------------------------------------------------

describe('sensitive value redaction', () => {
  it('does not log prompt text on launch error', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeErrorFetch(500),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'SECRET_PROMPT_CONTENT_DO_NOT_LOG',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain('SECRET_PROMPT_CONTENT_DO_NOT_LOG')
  })

  it('does not log CSRF token value', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeErrorFetch(403),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'do something',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'SUPER_SECRET_CSRF_VALUE_12345',
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain('SUPER_SECRET_CSRF_VALUE_12345')
  })

  it('does not log idempotency key value', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeErrorFetch(500),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'do something',
      idempotencyKey: 'UNIQUE_IDEM_KEY_DO_NOT_LOG_9999',
      csrfToken: 'csrf-token-xyz',
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain('UNIQUE_IDEM_KEY_DO_NOT_LOG_9999')
  })

  it('does not log session ID or token values from getCurrentSession error', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeErrorFetch(401),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.getCurrentSession()
    // Logger should only receive coarse metadata: path, status, error code
    for (const entry of loggedMessages) {
      const contextStr = JSON.stringify(entry.context ?? {})
      // Must not contain token-shaped values
      expect(contextStr).not.toMatch(/Bearer\s+\S+/)
      expect(contextStr).not.toMatch(/session[_-]?id\s*[:=]\s*\S+/i)
    }
  })

  it('does not log workspace paths or internal URLs in SSE error', () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => ({
        start(_onEvent: StreamEventCallback, onError: (err: Error) => void, _onClose: () => void) {
          onError(new Error('SSE connection failed: /workspace/secret/path/internal'))
        },
        close() {},
      }),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain('/workspace/secret/path/internal')
  })

  it('does not log raw tool arguments', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeErrorFetch(500),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'run bash with args: SECRET_TOOL_ARG_VALUE_XYZ',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain('SECRET_TOOL_ARG_VALUE_XYZ')
  })

  it('does not log bearer/token-looking values in logger context', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const client = createOperatorClient({
      fetch: makeErrorFetch(401),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'do something',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'Bearer_SUPER_SECRET_TOKEN_VALUE_ABCDEF',
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain('Bearer_SUPER_SECRET_TOKEN_VALUE_ABCDEF')
  })

  it('does not log raw session IDs or cookie values', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    // The logger context must never contain session IDs or cookie-shaped values.
    // We verify by checking that the logged context keys are only coarse metadata.
    const client = createOperatorClient({
      fetch: makeErrorFetch(401),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.getCurrentSession()
    for (const entry of loggedMessages) {
      const keys = Object.keys(entry.context ?? {})
      // Only coarse metadata keys are allowed: path, status, eventType, code
      for (const key of keys) {
        expect(['path', 'status', 'eventType', 'code', 'route']).toContain(key)
      }
    }
  })

  it('does not log dynamic runId in SSE stream error context — uses coarse route name', () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const sensitiveRunId = 'SENSITIVE_RUN_ID_DO_NOT_LOG_12345'
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => ({
        start(_onEvent: StreamEventCallback, onError: (err: Error) => void, _onClose: () => void) {
          onError(new Error('stream failed'))
        },
        close() {},
      }),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    client.connectRunStream(sensitiveRunId, {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain(sensitiveRunId)
  })

  it('does not log dynamic runId in getRunSnapshot error context — uses coarse route name', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const sensitiveRunId = 'SENSITIVE_RUN_ID_DO_NOT_LOG_67890'
    const client = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.getRunSnapshot(sensitiveRunId)
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain(sensitiveRunId)
  })

  it('does not log dynamic runId or requestId in decideRunApproval error context — uses coarse route name', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
    const sensitiveRunId = 'SENSITIVE_RUN_ID_DO_NOT_LOG_DECIDE'
    const sensitiveRequestId = 'SENSITIVE_REQUEST_ID_DO_NOT_LOG_ABCDE'
    const client = createOperatorClient({
      fetch: makeErrorFetch(409),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (message, context) => loggedMessages.push({message, context}),
        info: (message, context) => loggedMessages.push({message, context}),
        warning: (message, context) => loggedMessages.push({message, context}),
        error: (message, context) => loggedMessages.push({message, context}),
      },
    })
    await client.decideRunApproval(sensitiveRunId, sensitiveRequestId, 'once', 'idem-key-abc', 'csrf-token-xyz')
    const allLogged = JSON.stringify(loggedMessages)
    expect(allLogged).not.toContain(sensitiveRunId)
    expect(allLogged).not.toContain(sensitiveRequestId)
  })
})

// ---------------------------------------------------------------------------
// Fix 1: response.json() boundary cast through unknown
// (No direct test needed — this is a type-level fix; covered by type-check gate)

// Fix 2: GatewayProtocolError — malformed JSON on 2xx
// ---------------------------------------------------------------------------

function makeMalformedJsonFetch(): OperatorClientOptions['fetch'] {
  return async () =>
    new Response('not-valid-json{{{', {
      status: 200,
      headers: {'content-type': 'application/json'},
    })
}

describe('GatewayProtocolError — malformed JSON on 2xx', () => {
  it('returns protocol error (not network) when 2xx body is not valid JSON', async () => {
    const client = createOperatorClient({
      fetch: makeMalformedJsonFetch(),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('protocol error has a message', async () => {
    const client = createOperatorClient({
      fetch: makeMalformedJsonFetch(),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success && result.error.kind === 'protocol') {
      expect(typeof result.error.message).toBe('string')
      expect(result.error.message.length).toBeGreaterThan(0)
    }
  })

  it('protocol error is distinct from network error', async () => {
    // network error = fetch throws; protocol error = 2xx with bad body
    const throwingFetch: OperatorClientOptions['fetch'] = async () => {
      throw new Error('connection refused')
    }
    const clientNetwork = createOperatorClient({
      fetch: throwingFetch,
      createEventStream: makeEventStream([]),
    })
    const networkResult = await clientNetwork.getCurrentSession()

    const clientProtocol = createOperatorClient({
      fetch: makeMalformedJsonFetch(),
      createEventStream: makeEventStream([]),
    })
    const protocolResult = await clientProtocol.getCurrentSession()

    expect(networkResult.success).toBe(false)
    expect(protocolResult.success).toBe(false)
    if (!networkResult.success && !protocolResult.success) {
      expect(networkResult.error.kind).toBe('network')
      expect(protocolResult.error.kind).toBe('protocol')
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 3: GatewayHttpError.code field removed
// ---------------------------------------------------------------------------

describe('GatewayHttpError has no code field', () => {
  it('http error does not have a code property', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(500),
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success && result.error.kind === 'http') {
      expect('code' in result.error).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// SSE status frame carries all OperatorRunStatus fields
// ---------------------------------------------------------------------------

describe('status SSE frame carries all OperatorRunStatus fields', () => {
  it('delivers status frame with stale flag', () => {
    const events: RunStreamEvent[] = [
      {
        type: 'status',
        data: {
          runId: 'run-001',
          entityRef: 'fro-bot/agent',
          surface: 'github',
          phase: 'EXECUTING',
          status: 'running',
          startedAt: '2026-06-18T20:00:00Z',
          stale: true,
        },
      },
    ]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('status')
    if (received[0]?.type === 'status') {
      expect(received[0].data.stale).toBe(true)
      expect(received[0].data.runId).toBe('run-001')
    }
  })
})

// ---------------------------------------------------------------------------
// SSE reset frame carries runId and reason
// ---------------------------------------------------------------------------

describe('reset SSE frame carries runId and reason', () => {
  it('delivers reset frame with writer-error reason', () => {
    const events: RunStreamEvent[] = [
      {type: 'reset', data: {runId: 'run-001', reason: 'writer-error'}},
    ]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
    if (received[0]?.type === 'reset') {
      expect(received[0].data.reason).toBe('writer-error')
      expect(received[0].data.runId).toBe('run-001')
    }
  })

  it('delivers reset frame with max-duration reason', () => {
    const events: RunStreamEvent[] = [
      {type: 'reset', data: {runId: 'run-001', reason: 'max-duration'}},
    ]
    const received: RunStreamEvent[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream(events),
    })
    client.connectRunStream('run-001', {
      onEvent: e => received.push(e),
      onError: () => {},
      onClose: () => {},
    })
    expect(received[0]?.type).toBe('reset')
    if (received[0]?.type === 'reset') {
      expect(received[0].data.reason).toBe('max-duration')
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 6: validateOperatorPath — path traversal / unsafe control chars
// ---------------------------------------------------------------------------

describe('validateOperatorPath — path traversal and unsafe chars', () => {
  it('rejects /operator/../admin (decoded .. segment)', () => {
    const result = validateOperatorPath('/operator/../admin')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects /operator/../../internal (double traversal)', () => {
    const result = validateOperatorPath('/operator/../../internal')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects path with leading whitespace', () => {
    const result = validateOperatorPath(' /operator/session')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects path with trailing whitespace', () => {
    const result = validateOperatorPath('/operator/session ')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects path with CRLF injection', () => {
    const result = validateOperatorPath('/operator/session\r\nX-Injected: evil')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('rejects path with null byte', () => {
    const result = validateOperatorPath('/operator/session\u0000')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('accepts /operator/runs/abc:def (colon in segment — encoded by route builders)', () => {
    // Route builders encode colons; direct paths with colons in segments are accepted
    // since colons are valid in path segments per RFC 3986 (not in first segment)
    const result = validateOperatorPath('/operator/runs/abc:def')
    expect(result).toBeNull()
  })

  it('still rejects scheme-like paths (http:)', () => {
    const result = validateOperatorPath('http://evil.example.com/operator/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('still rejects protocol-relative paths', () => {
    const result = validateOperatorPath('//evil.example.com/operator/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('still rejects non-operator paths', () => {
    const result = validateOperatorPath('/admin/runs')
    expect(result).not.toBeNull()
    expect(result?.code).toBe('invalid_path')
  })

  it('still accepts valid /operator/runs/run-001', () => {
    const result = validateOperatorPath('/operator/runs/run-001')
    expect(result).toBeNull()
  })

  it('still accepts /operator/runs/run-001/approvals/req-001/decision (per-run decision route)', () => {
    const result = validateOperatorPath('/operator/runs/run-001/approvals/req-001/decision')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listRunApprovals — blank/whitespace runId rejection (migrated from Fix 7)
// ---------------------------------------------------------------------------

// (listRunApprovals blank runId validation is tested inline in the listRunApprovals describe block above)

// ---------------------------------------------------------------------------
// Fix 8: connectRunStream returns Result<EventStreamHandle, GatewayClientError>
// ---------------------------------------------------------------------------

describe('connectRunStream — Result return type', () => {
  it('returns ok(handle) on valid runId', () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: makeEventStream([]),
    })
    const result = client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.close).toBe('function')
    }
  })

  it('returns err(validation) on blank runId — does not call onError', () => {
    let streamCreated = false
    let onErrorCalled = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {start: () => {}, close: () => {}}
      },
    })
    const result = client.connectRunStream('', {
      onEvent: () => {},
      onError: () => {
        onErrorCalled = true
      },
      onClose: () => {},
    })
    expect(result.success).toBe(false)
    expect(streamCreated).toBe(false)
    expect(onErrorCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('returns err(validation) on whitespace-only runId', () => {
    let streamCreated = false
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => {
        streamCreated = true
        return {start: () => {}, close: () => {}}
      },
    })
    const result = client.connectRunStream('   ', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(result.success).toBe(false)
    expect(streamCreated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fix 9: createEventStream / handle.start setup failures → err({kind:'network'})
// ---------------------------------------------------------------------------

describe('connectRunStream — setup error handling', () => {
  it('returns err(network) when createEventStream throws', () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: () => {
        throw new Error('SSE factory exploded')
      },
    })
    const result = client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
    }
  })

  it('returns err(network) when handle.start throws', () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: () => ({
        start: () => {
          throw new Error('start exploded')
        },
        close: () => {},
      }),
    })
    const result = client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
    }
  })

  it('does not log raw thrown error message from setup failure', () => {
    const loggedMessages: string[] = []
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: () => {
        throw new Error('INTERNAL_SECRET_PATH_DO_NOT_LOG')
      },
      logger: {
        debug: msg => loggedMessages.push(msg),
        info: msg => loggedMessages.push(msg),
        warning: msg => loggedMessages.push(msg),
        error: msg => loggedMessages.push(msg),
      },
    })
    client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })
    const allLogged = loggedMessages.join(' ')
    expect(allLogged).not.toContain('INTERNAL_SECRET_PATH_DO_NOT_LOG')
  })
})

// ---------------------------------------------------------------------------
// Fix 10: redirect: 'error' in launchRun and decideRunApproval
// ---------------------------------------------------------------------------

describe('launchRun — redirect: error', () => {
  it('passes redirect: error in fetch init', async () => {
    let capturedInit: RequestInit | undefined
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        capturedInit = init
        return new Response(JSON.stringify({runId: 'r1', status: 'queued'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'fix the bug',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(capturedInit?.redirect).toBe('error')
  })
})

// (decideRunApproval redirect:error is tested inline in the decideRunApproval describe block above)

// ---------------------------------------------------------------------------
// Fix 13: No-logger smoke coverage
// ---------------------------------------------------------------------------

describe('no-logger smoke coverage', () => {
  it('HTTP error path works without logger', async () => {
    const client = createOperatorClient({
      fetch: makeErrorFetch(500),
      createEventStream: makeEventStream([]),
      // no logger
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
    }
  })

  it('stream error path works without logger', () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({}),
      createEventStream: (_path, _opts) => ({
        start(_onEvent: StreamEventCallback, onError: (err: Error) => void, _onClose: () => void) {
          onError(new Error('stream failed'))
        },
        close() {},
      }),
      // no logger
    })
    let errorReceived: Error | null = null
    const result = client.connectRunStream('run-001', {
      onEvent: () => {},
      onError: e => {
        errorReceived = e
      },
      onClose: () => {},
    })
    expect(result.success).toBe(true)
    expect(errorReceived).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fix 14: Network rejection — fetchImpl throwing
// ---------------------------------------------------------------------------

describe('network error — fetchImpl throws', () => {
  it('returns network error when fetch throws', async () => {
    const client = createOperatorClient({
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
      if (result.error.kind === 'network') {
        expect(result.error.message).toBe('Network error')
      }
    }
  })

  it('does not leak raw error message from fetch throw', async () => {
    const client = createOperatorClient({
      fetch: async () => {
        throw new Error('INTERNAL_NETWORK_SECRET_DO_NOT_LOG')
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.getCurrentSession()
    expect(result.success).toBe(false)
    if (!result.success && result.error.kind === 'network') {
      expect(result.error.message).not.toContain('INTERNAL_NETWORK_SECRET_DO_NOT_LOG')
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 15: Whitespace-only idempotency key tests
// ---------------------------------------------------------------------------

describe('launchRun — whitespace-only idempotencyKey', () => {
  it('rejects whitespace-only idempotencyKey before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.launchRun({
      repo: 'fro-bot/agent',
      prompt: 'fix the bug',
      idempotencyKey: '   ',
      csrfToken: 'csrf-token-xyz',
    })
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_idempotency_key')
      }
    }
  })
})

// (decideRunApproval whitespace-only CSRF and idempotencyKey validation is tested inline in the decideRunApproval describe block above)

// ---------------------------------------------------------------------------
// Fix 16: HTTP error logging uses route templates, not dynamic IDs
// ---------------------------------------------------------------------------

describe('HTTP error logging uses route templates', () => {
  it('does not log dynamic runId in getRunSnapshot HTTP error', async () => {
    const loggedContexts: Record<string, unknown>[] = []
    const sensitiveRunId = 'SENSITIVE_RUN_ID_ROUTE_TEMPLATE_TEST'
    const client = createOperatorClient({
      fetch: makeErrorFetch(404),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        info: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        warning: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        error: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
      },
    })
    await client.getRunSnapshot(sensitiveRunId)
    const allLogged = JSON.stringify(loggedContexts)
    expect(allLogged).not.toContain(sensitiveRunId)
    // Should contain the route template instead
    expect(allLogged).toContain('/operator/runs/:runId')
  })

  it('does not log dynamic runId or requestId in decideRunApproval HTTP error', async () => {
    const loggedContexts: Record<string, unknown>[] = []
    const sensitiveRunId = 'SENSITIVE_RUN_ID_ROUTE_TEMPLATE_TEST'
    const sensitiveRequestId = 'SENSITIVE_REQ_ID_ROUTE_TEMPLATE_TEST'
    const client = createOperatorClient({
      fetch: makeErrorFetch(409),
      createEventStream: makeEventStream([]),
      logger: {
        debug: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        info: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        warning: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
        error: (_msg, ctx) => { if (ctx) loggedContexts.push(ctx) },
      },
    })
    await client.decideRunApproval(sensitiveRunId, sensitiveRequestId, 'once', 'idem-key-abc', 'csrf-token-xyz')
    const allLogged = JSON.stringify(loggedContexts)
    expect(allLogged).not.toContain(sensitiveRunId)
    expect(allLogged).not.toContain(sensitiveRequestId)
    expect(allLogged).toContain('/operator/runs/:runId/approvals/:requestId/decision')
  })
})
