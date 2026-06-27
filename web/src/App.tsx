import {useState} from 'react'
import {AppShell} from './shell/AppShell.tsx'
import {Operator} from './views/Operator.tsx'
import type {OperatorState} from './operator/state.ts'

export default function App() {
  const [operatorState, setOperatorState] = useState<OperatorState>('ready')

  return (
    <AppShell>
      <Operator state={operatorState} onRuntimeStateChange={setOperatorState} />
    </AppShell>
  )
}
