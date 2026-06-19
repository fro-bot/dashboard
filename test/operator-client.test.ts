/**
 * Typed Gateway operator API client contract tests.
 *
 * @contract-churn-prone — Gateway Phase B route units (4-6, 8) have not landed.
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
  ApprovalDecisionRequest,
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
    owner: 'fro-bot',
    repo: 'agent',
    prompt: 'fix the bug',
    idempotencyKey: 'idem-key-abc',
    csrfToken: 'csrf-token-xyz',
  }

  it('returns run data on success', async () => {
    const runData = {runId: 'run-001', status: 'queued' as const}
    const client = createOperatorClient({
      fetch: makeOkFetch(runData),
      createEventStream: makeEventStream([]),
    })
    const result = await client.launchRun(validRequest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runId).toBe('run-001')
      expect(result.data.status).toBe('queued')
    }
  })

  it('rejects before fetch when csrfToken is missing', async () => {
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

  it('rejects before fetch when idempotencyKey is missing', async () => {
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
        return new Response(JSON.stringify({runId: 'r1', status: 'queued'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun(validRequest)
    expect(calls[0]).toBe('/operator/runs')
  })

  it('sends CSRF token as X-CSRF-Token header', async () => {
    const headers: Record<string, string> = {}
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        const h = init?.headers as Record<string, string> | undefined
        if (h) Object.assign(headers, h)
        return new Response(JSON.stringify({runId: 'r1', status: 'queued'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun(validRequest)
    expect(headers['x-csrf-token']).toBe('csrf-token-xyz')
  })

  it('sends idempotency key as Idempotency-Key header', async () => {
    const headers: Record<string, string> = {}
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        const h = init?.headers as Record<string, string> | undefined
        if (h) Object.assign(headers, h)
        return new Response(JSON.stringify({runId: 'r1', status: 'queued'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.launchRun(validRequest)
    expect(headers['idempotency-key']).toBe('idem-key-abc')
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
      {type: 'heartbeat', timestamp: '2026-06-18T20:00:00Z'},
      {type: 'run.state', runId: 'run-001', status: 'running', timestamp: '2026-06-18T20:00:01Z'},
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
    expect(received[0]?.type).toBe('heartbeat')
    expect(received[1]?.type).toBe('run.state')
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

  it('delivers reset event when replay is unavailable', () => {
    const events: RunStreamEvent[] = [{type: 'stream.reset', reason: 'replay_unavailable'}]
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
    expect(received[0]?.type).toBe('stream.reset')
  })

  it('delivers approval events', () => {
    const events: RunStreamEvent[] = [
      {
        type: 'approval.pending',
        requestId: 'req-1',
        runId: 'run-001',
        safeSummary: 'run a script',
        approvalScope: 'tool_use',
        timestamp: '2026-06-18T20:00:00Z',
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
    expect(received[0]?.type).toBe('approval.pending')
  })

  it('delivers terminal run state events', () => {
    const terminalStatuses = ['succeeded', 'failed', 'cancelled'] as const
    for (const status of terminalStatuses) {
      const events: RunStreamEvent[] = [
        {type: 'run.state', runId: 'run-001', status, timestamp: '2026-06-18T20:00:00Z'},
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
      expect(received[0]?.type).toBe('run.state')
      if (received[0]?.type === 'run.state') {
        expect(received[0].status).toBe(status)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// listPendingApprovals
// ---------------------------------------------------------------------------

describe('listPendingApprovals', () => {
  it('returns pending approvals list on success', async () => {
    const approvals = [
      {
        requestId: 'req-1',
        runId: 'run-001',
        safeSummary: 'run a script',
        approvalScope: 'tool_use',
        createdAt: '2026-06-18T20:00:00Z',
      },
    ]
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listPendingApprovals()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.approvals).toHaveLength(1)
      expect(result.data.approvals[0]?.requestId).toBe('req-1')
    }
  })

  it('uses relative path /operator/approvals', async () => {
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
    await client.listPendingApprovals()
    expect(calls[0]).toBe('/operator/approvals')
  })

  it('filters by runId when provided', async () => {
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
    await client.listPendingApprovals({runId: 'run-001'})
    expect(calls[0]).toBe('/operator/approvals?runId=run-001')
  })
})

// ---------------------------------------------------------------------------
// decideApproval — CSRF + idempotency key guards
// ---------------------------------------------------------------------------

describe('decideApproval', () => {
  const validDecision: ApprovalDecisionRequest = {
    requestId: 'req-1',
    decision: 'approve',
    approvalScope: 'tool_use',
    idempotencyKey: 'idem-decision-abc',
    csrfToken: 'csrf-token-xyz',
  }

  it('returns decision result on success', async () => {
    const decisionResult = {
      state: 'claimed' as const,
      requestId: 'req-1',
      timestamp: '2026-06-18T20:00:00Z',
    }
    const client = createOperatorClient({
      fetch: makeOkFetch(decisionResult),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval(validDecision)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('claimed')
    }
  })

  it('rejects before fetch when csrfToken is missing', async () => {
    let fetchCalled = false
    const neverFetch: OperatorClientOptions['fetch'] = async () => {
      fetchCalled = true
      return new Response('', {status: 200})
    }
    const client = createOperatorClient({
      fetch: neverFetch,
      createEventStream: makeEventStream([]),
    })
    const req = {...validDecision, csrfToken: ''}
    const result = await client.decideApproval(req)
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_csrf')
      }
    }
  })

  it('rejects before fetch when idempotencyKey is missing', async () => {
    let fetchCalled = false
    const neverFetch: OperatorClientOptions['fetch'] = async () => {
      fetchCalled = true
      return new Response('', {status: 200})
    }
    const client = createOperatorClient({
      fetch: neverFetch,
      createEventStream: makeEventStream([]),
    })
    const req = {...validDecision, idempotencyKey: ''}
    const result = await client.decideApproval(req)
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_idempotency_key')
      }
    }
  })

  it('uses relative path /operator/approvals/:requestId/decision', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(JSON.stringify({state: 'claimed', requestId: 'req-1', timestamp: '2026-06-18T20:00:00Z'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideApproval(validDecision)
    expect(calls[0]).toBe('/operator/approvals/req-1/decision')
  })

  it('handles already_claimed state', async () => {
    const decisionResult = {
      state: 'already_claimed' as const,
      requestId: 'req-1',
      timestamp: '2026-06-18T20:00:00Z',
    }
    const client = createOperatorClient({
      fetch: makeOkFetch(decisionResult),
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval(validDecision)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.state).toBe('already_claimed')
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

  it('rejects requestId with literal slash in decideApproval before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({
      requestId: 'req/evil',
      decision: 'approve',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  it('rejects requestId with percent-encoded slash (%2F) in decideApproval before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({
      requestId: 'req%2Fevil',
      decision: 'approve',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  it('rejects requestId with percent-encoded backslash (%5C) in decideApproval before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({
      requestId: 'req%5Cevil',
      decision: 'reject',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(fetchCalled).toBe(false)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
  })

  it('encodes requestId with query chars in decideApproval', async () => {
    const calls: string[] = []
    const client = createOperatorClient({
      fetch: async (input, _init) => {
        calls.push(typeof input === 'string' ? input : String(input))
        return new Response(
          JSON.stringify({state: 'claimed', requestId: 'req?x=1', timestamp: '2026-06-18T20:00:00Z'}),
          {status: 200, headers: {'content-type': 'application/json'}},
        )
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideApproval({
      requestId: 'req?x=1',
      decision: 'reject',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(calls[0]).toBe('/operator/approvals/req%3Fx%3D1/decision')
  })
})

// ---------------------------------------------------------------------------
// decideApproval — all approval decision states
// ---------------------------------------------------------------------------

describe('decideApproval — all decision states', () => {
  const validDecision: ApprovalDecisionRequest = {
    requestId: 'req-state-test',
    decision: 'approve',
    approvalScope: 'tool_use',
    idempotencyKey: 'idem-state-abc',
    csrfToken: 'csrf-state-xyz',
  }

  // Canonical OperatorDecisionState values per contract v1.0.0
  const allStates = ['pending', 'claimed', 'already_claimed', 'scope_mismatch', 'failed_to_settle', 'unavailable'] as const

  for (const state of allStates) {
    it(`handles ${state} state`, async () => {
      const decisionResult = {state, requestId: 'req-state-test', timestamp: '2026-06-18T20:00:00Z'}
      const client = createOperatorClient({
        fetch: makeOkFetch(decisionResult),
        createEventStream: makeEventStream([]),
      })
      const result = await client.decideApproval(validDecision)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.state).toBe(state)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// connectRunStream — both stream.reset reasons
// ---------------------------------------------------------------------------

describe('connectRunStream — stream.reset reasons', () => {
  it('delivers stream.reset with replay_unavailable reason', () => {
    const events: RunStreamEvent[] = [{type: 'stream.reset', reason: 'replay_unavailable'}]
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
    expect(received[0]?.type).toBe('stream.reset')
    if (received[0]?.type === 'stream.reset') {
      expect(received[0].reason).toBe('replay_unavailable')
    }
  })

  it('delivers stream.reset with resnapshot reason', () => {
    const events: RunStreamEvent[] = [{type: 'stream.reset', reason: 'resnapshot'}]
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
    expect(received[0]?.type).toBe('stream.reset')
    if (received[0]?.type === 'stream.reset') {
      expect(received[0].reason).toBe('resnapshot')
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

  it('accepts /operator/approvals?runId=run-001', () => {
    const result = validateOperatorPath('/operator/approvals?runId=run-001')
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

describe('decideApproval — blank requestId validation', () => {
  const validBase = {
    decision: 'approve' as const,
    approvalScope: 'tool_use',
    idempotencyKey: 'idem-key-abc',
    csrfToken: 'csrf-token-xyz',
  }

  it('rejects blank requestId before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({...validBase, requestId: ''})
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  it('rejects whitespace-only requestId before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({...validBase, requestId: '   '})
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_request_id')
      }
    }
  })

  it('rejects blank requestId even with valid CSRF and idempotency key', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({
      requestId: '',
      decision: 'reject',
      approvalScope: 'tool_use',
      idempotencyKey: 'valid-idem-key',
      csrfToken: 'valid-csrf-token',
    })
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
  })
})

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
          onEvent({type: 'heartbeat', timestamp: '2026-06-18T20:00:00Z'}, {eventId: 'evt-001'})
          onEvent({type: 'run.state', runId: 'run-001', status: 'running', timestamp: '2026-06-18T20:00:01Z'}, {eventId: 'evt-002'})
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
      createEventStream: makeEventStream([{type: 'heartbeat', timestamp: '2026-06-18T20:00:00Z'}]),
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
            onEvent({type: 'heartbeat', timestamp: '2026-06-18T20:00:00Z'}, {eventId: 'evt-100'})
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
      owner: 'fro-bot',
      repo: 'agent',
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
      owner: 'fro-bot',
      repo: 'agent',
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
      owner: 'fro-bot',
      repo: 'agent',
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
      owner: 'fro-bot',
      repo: 'agent',
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
      owner: 'fro-bot',
      repo: 'agent',
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

  it('does not log dynamic requestId in decideApproval error context — uses coarse route name', async () => {
    const loggedMessages: {message: string; context?: Record<string, unknown>}[] = []
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
    await client.decideApproval({
      requestId: sensitiveRequestId,
      decision: 'approve',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    const allLogged = JSON.stringify(loggedMessages)
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
// Fix 4: approval.failed_to_settle must include timestamp
// ---------------------------------------------------------------------------

describe('approval.failed_to_settle SSE event includes timestamp', () => {
  it('delivers approval.failed_to_settle with timestamp field', () => {
    const events: RunStreamEvent[] = [
      {
        type: 'approval.failed_to_settle',
        requestId: 'req-1',
        runId: 'run-001',
        reason: 'lock_timeout',
        timestamp: '2026-06-18T20:00:00Z',
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
    expect(received[0]?.type).toBe('approval.failed_to_settle')
    if (received[0]?.type === 'approval.failed_to_settle') {
      expect(received[0].timestamp).toBe('2026-06-18T20:00:00Z')
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 5: approval.confirmed.outcome narrowed to 'approved' | 'rejected'
// ---------------------------------------------------------------------------

describe('approval.confirmed outcome is narrowed', () => {
  it('delivers approval.confirmed with approved outcome', () => {
    const events: RunStreamEvent[] = [
      {
        type: 'approval.confirmed',
        requestId: 'req-1',
        runId: 'run-001',
        outcome: 'approved',
        timestamp: '2026-06-18T20:00:00Z',
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
    expect(received[0]?.type).toBe('approval.confirmed')
    if (received[0]?.type === 'approval.confirmed') {
      expect(received[0].outcome).toBe('approved')
    }
  })

  it('delivers approval.confirmed with rejected outcome', () => {
    const events: RunStreamEvent[] = [
      {
        type: 'approval.confirmed',
        requestId: 'req-1',
        runId: 'run-001',
        outcome: 'rejected',
        timestamp: '2026-06-18T20:00:00Z',
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
    expect(received[0]?.type).toBe('approval.confirmed')
    if (received[0]?.type === 'approval.confirmed') {
      expect(received[0].outcome).toBe('rejected')
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

  it('still accepts /operator/approvals?runId=run-001 (query string)', () => {
    const result = validateOperatorPath('/operator/approvals?runId=run-001')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fix 7: listPendingApprovals — blank/whitespace runId rejection
// ---------------------------------------------------------------------------

describe('listPendingApprovals — blank runId validation', () => {
  it('rejects blank runId before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response(JSON.stringify({approvals: []}), {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.listPendingApprovals({runId: ''})
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
        return new Response(JSON.stringify({approvals: []}), {status: 200, headers: {'content-type': 'application/json'}})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.listPendingApprovals({runId: '   '})
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_run_id')
      }
    }
  })

  it('still accepts undefined runId (no filter)', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals: []}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listPendingApprovals()
    expect(result.success).toBe(true)
  })

  it('still accepts valid runId', async () => {
    const client = createOperatorClient({
      fetch: makeOkFetch({approvals: []}),
      createEventStream: makeEventStream([]),
    })
    const result = await client.listPendingApprovals({runId: 'run-001'})
    expect(result.success).toBe(true)
  })
})

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
// Fix 10: redirect: 'error' in launchRun and decideApproval
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
      owner: 'fro-bot',
      repo: 'agent',
      prompt: 'fix the bug',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(capturedInit?.redirect).toBe('error')
  })
})

describe('decideApproval — redirect: error', () => {
  it('passes redirect: error in fetch init', async () => {
    let capturedInit: RequestInit | undefined
    const client = createOperatorClient({
      fetch: async (_input, init) => {
        capturedInit = init
        return new Response(JSON.stringify({state: 'claimed', requestId: 'req-1', timestamp: '2026-06-18T20:00:00Z'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      },
      createEventStream: makeEventStream([]),
    })
    await client.decideApproval({
      requestId: 'req-1',
      decision: 'approve',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    expect(capturedInit?.redirect).toBe('error')
  })
})

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
      owner: 'fro-bot',
      repo: 'agent',
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

describe('decideApproval — whitespace-only CSRF and idempotencyKey', () => {
  it('rejects whitespace-only csrfToken before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({
      requestId: 'req-1',
      decision: 'approve',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: '   ',
    })
    expect(result.success).toBe(false)
    expect(fetchCalled).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
      if (result.error.kind === 'validation') {
        expect(result.error.code).toBe('missing_csrf')
      }
    }
  })

  it('rejects whitespace-only idempotencyKey before fetch', async () => {
    let fetchCalled = false
    const client = createOperatorClient({
      fetch: async () => {
        fetchCalled = true
        return new Response('', {status: 200})
      },
      createEventStream: makeEventStream([]),
    })
    const result = await client.decideApproval({
      requestId: 'req-1',
      decision: 'approve',
      approvalScope: 'tool_use',
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

  it('does not log dynamic requestId in decideApproval HTTP error', async () => {
    const loggedContexts: Record<string, unknown>[] = []
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
    await client.decideApproval({
      requestId: sensitiveRequestId,
      decision: 'approve',
      approvalScope: 'tool_use',
      idempotencyKey: 'idem-key-abc',
      csrfToken: 'csrf-token-xyz',
    })
    const allLogged = JSON.stringify(loggedContexts)
    expect(allLogged).not.toContain(sensitiveRequestId)
    expect(allLogged).toContain('/operator/approvals/:requestId/decision')
  })
})
