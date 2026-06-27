/**
 * Operator — root operator app shell view.
 *
 * Renders the operator surface at `/`. Run-index integration is tracked
 * separately and will be connected in a later unit.
 *
 * Accessibility:
 * - Clear heading for the operator shell identity.
 * - aria-live region for state changes.
 * - Touch-friendly targets for all interactive controls.
 */

export function Operator() {
  return (
    <div data-testid="operator-shell">
      <h1
        style={{
          fontSize: 'var(--text-h3)',
          fontWeight: 700,
          letterSpacing: 'var(--tracking-heading)',
          color: 'var(--color-text)',
          marginBottom: 'var(--space-4)',
        }}
      >
        Operator
      </h1>

      <div
        aria-live="polite"
        aria-atomic="true"
        data-testid="operator-status-region"
        style={{
          fontSize: 'var(--text-body-sm)',
          color: 'var(--color-text-muted)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <p>Connecting to operator runtime…</p>
      </div>

      <div
        data-testid="operator-content"
        style={{
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-8)',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--text-body-sm)',
        }}
      >
        <p>Operator runtime not yet available.</p>
        <p style={{marginTop: 'var(--space-2)'}}>
          Run-index integration is tracked separately and will be connected in a later unit.
        </p>
      </div>
    </div>
  )
}
