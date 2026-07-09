import {useEffect, useState} from 'react'
import {AppShell} from './shell/AppShell.tsx'
import {Operator} from './views/Operator.tsx'
import type {OperatorState} from './operator/state.ts'

interface FixtureState {
  readonly fixtureMode: true
  readonly fixtureEndpointBase: string
  readonly fixtureSessionId: string
}

export default function App() {
  const [operatorState, setOperatorState] = useState<OperatorState>('ready')
  const [fixtureState, setFixtureState] = useState<FixtureState | null>(null)
  // In dev builds, hold the operator runtime in 'loading' until fixture detection
  // settles. This prevents the race where the non-fixture runtime starts with
  // /operator endpoints before /__fixture/operator is known.
  // In production, detection never runs so we start settled immediately.
  const [fixtureDetectionSettled, setFixtureDetectionSettled] = useState(!import.meta.env.DEV)

  useEffect(() => {
    // Fixture detection is dev-only. The import.meta.env.DEV guard ensures
    // production bundles tree-shake this entire branch including the dynamic
    // import of fixture-runtime-loader, so no fixture route strings ship in prod.
    if (!import.meta.env.DEV) return

    let cancelled = false
    void (async () => {
      const {fetchFixtureSession, FIXTURE_OPERATOR_PREFIX} = await import('./operator/fixture-runtime-loader.ts')
      const session = await fetchFixtureSession()
      if (cancelled) return
      if (session !== null) {
        setFixtureState({
          fixtureMode: true,
          fixtureEndpointBase: FIXTURE_OPERATOR_PREFIX as string,
          fixtureSessionId: session.fixtureSessionId,
        })
      }
      setFixtureDetectionSettled(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AppShell
      pushEndpointBase={fixtureState ? `${fixtureState.fixtureEndpointBase}/push` : undefined}
    >
      <Operator
        state={fixtureDetectionSettled ? operatorState : 'loading'}
        onRuntimeStateChange={setOperatorState}
        fixtureMode={fixtureState?.fixtureMode}
        fixtureEndpointBase={fixtureState?.fixtureEndpointBase}
        fixtureSessionId={fixtureState?.fixtureSessionId}
      />
    </AppShell>
  )
}
