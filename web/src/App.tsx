export default function App() {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        backgroundColor: 'var(--color-bg)',
        color: 'var(--color-text)',
      }}
    >
      <div className="text-center">
        <h1
          className="text-3xl font-bold"
          style={{letterSpacing: 'var(--tracking-heading)'}}
        >
          Fro Bot Dashboard
        </h1>
        <p style={{marginTop: 'var(--space-2)', color: 'var(--color-text-muted)'}}>
          Monitoring surface — coming soon.
        </p>
      </div>
    </div>
  )
}
