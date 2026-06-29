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
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AppShell>
      <Operator
        state={operatorState}
        onRuntimeStateChange={setOperatorState}
        fixtureMode={fixtureState?.fixtureMode}
        fixtureEndpointBase={fixtureState?.fixtureEndpointBase}
        fixtureSessionId={fixtureState?.fixtureSessionId}
      />
    </AppShell>
  )
}
