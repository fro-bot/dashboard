import {AppShell} from './shell/AppShell.tsx'
import {Operator} from './views/Operator.tsx'

export default function App() {
  return (
    <AppShell>
      <Operator state="ready" />
    </AppShell>
  )
}
