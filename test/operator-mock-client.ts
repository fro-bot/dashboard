import type {EventStreamHandle, OperatorClient} from '../src/gateway/operator-client.ts'
import {createOperatorClient} from '../src/gateway/operator-client.ts'
import {FIXTURE_RUN_TIMELINE} from '../src/gateway/operator-fixtures.ts'

/**
 * Create a mock OperatorClient built via the real createOperatorClient factory
 * with an injected fetch that THROWS if called (proving the UI never hits network
 * in mock render) and an injected createEventStream that replays fixture events
 * synchronously (no real SSE).
 *
 * The skeleton SSR render must NOT call network — it renders from static fixtures
 * directly. This mock client exists to satisfy the contract/type-surface and for
 * any interaction tests.
 */
export function createMockOperatorClient(): OperatorClient {
  // Injected fetch that throws if called — proves no network calls during SSR
  const throwingFetch = async (_input: string, _init?: RequestInit): Promise<Response> => {
    throw new Error(
      'Mock operator client fetch was called — this proves a live network call was attempted. ' +
      'The operator UI skeleton must render from static fixtures only, with zero /operator/* calls.',
    )
  }

  // Injected createEventStream that replays fixture events synchronously
  const fixtureEventStream = (_path: string): EventStreamHandle => {
    return {
      start: (onEvent, _onError, onClose) => {
        // Replay fixture timeline events synchronously
        for (const event of FIXTURE_RUN_TIMELINE) {
          onEvent(event)
        }
        onClose()
      },
      close: () => {
        // No-op for fixture stream
      },
    }
  }

  return createOperatorClient({
    fetch: throwingFetch,
    createEventStream: fixtureEventStream,
  })
}
