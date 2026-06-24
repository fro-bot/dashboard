import {AppShell} from './shell/AppShell.tsx'
import {Monitoring} from './views/Monitoring.tsx'

export default function App() {
  return (
    <AppShell>
      <Monitoring />
    </AppShell>
  )
}
