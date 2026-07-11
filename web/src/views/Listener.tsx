import { useEffect, useState, useCallback, useRef } from 'react'
import {
  fetchListenerMessages,
  ackListenerMessage,
  ackAllListenerMessages,
  type ListenerMessagesResponse,
  type ListenerMessage,
} from '../api/listener.ts'

type ViewState =
  | { state: 'loading' }
  | { state: 'error'; reason: string }
  | { state: 'empty' }
  | { state: 'ready'; data: ListenerMessagesResponse }

const POLL_INTERVAL_MS = 30000

export function ListenerChannel() {
  const [viewState, setViewState] = useState<ViewState>({ state: 'loading' })
  const [ackingId, setAckingId] = useState<string | 'all' | null>(null)
  const isFetchingRef = useRef(false)

  const loadData = useCallback(async (isInitial = false) => {
    if (isFetchingRef.current) return
    isFetchingRef.current = true

    if (isInitial) {
      setViewState({ state: 'loading' })
    }

    const abortController = new AbortController()
    const result = await fetchListenerMessages({ limit: 100, abortSignal: abortController.signal })
    isFetchingRef.current = false

    if (!result.ok) {
      setViewState(prev => (prev.state === 'ready' ? prev : { state: 'error', reason: result.reason }))
      return
    }

    if (result.data.messages.length === 0) {
      setViewState({ state: 'empty' })
    } else {
      setViewState({ state: 'ready', data: result.data })
    }
  }, [])

  useEffect(() => {
    void loadData(true)
  }, [loadData])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadData(false)
      }
    }
    const handleFocus = () => {
      void loadData(false)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    const intervalId = setInterval(() => {
      void loadData(false)
    }, POLL_INTERVAL_MS)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
      clearInterval(intervalId)
    }
  }, [loadData])

  const handleAck = async (id: string) => {
    if (ackingId) return
    setAckingId(id)
    const success = await ackListenerMessage(id)
    setAckingId(null)
    if (success) {
      void loadData(false)
    }
  }

  const handleAckAll = async () => {
    if (ackingId) return
    setAckingId('all')
    const success = await ackAllListenerMessages()
    setAckingId(null)
    if (success) {
      void loadData(false)
    }
  }

  return (
    <div className="operator-panel" data-testid="listener-channel">
      <div className="listener-header" style={{ marginBottom: 'var(--space-4)', alignItems: 'center' }}>
        <h2 className="operator-section-heading" style={{ marginBottom: 0 }}>
          Operator Inbox
        </h2>
        {viewState.state === 'ready' && viewState.data.unreadCount > 0 && (
          <button
            type="button"
            className="run-cancel-btn-dismiss"
            onClick={handleAckAll}
            disabled={ackingId === 'all'}
            style={{ minHeight: '36px', padding: 'var(--space-1) var(--space-3)' }}
          >
            {ackingId === 'all' ? 'Marking...' : 'Mark all read'}
          </button>
        )}
      </div>

      {viewState.state === 'loading' && (
        <div data-testid="listener-loading" className="run-index-skeleton-container" aria-live="polite">
          {[1, 2, 3].map((i) => (
            <div key={i} className="run-card-skeleton">
              <span className="skeleton-item skeleton-pill" aria-hidden="true" />
              <span className="skeleton-item skeleton-repo" aria-hidden="true" />
              <span className="skeleton-item skeleton-time" aria-hidden="true" />
            </div>
          ))}
        </div>
      )}

      {viewState.state === 'error' && (
        <div data-testid="listener-error" className="operator-warning-panel operator-failure-state-unavailable" role="alert">
          Failed to load messages ({viewState.reason}). Will retry.
        </div>
      )}

      {viewState.state === 'empty' && (
        <div data-testid="listener-empty" className="operator-empty-state">
          <div className="operator-empty-icon" aria-hidden="true" style={{ opacity: 0.2 }}>✓</div>
          <p className="operator-empty-title">Inbox Zero</p>
          <p className="operator-empty-desc">No messages from infra or agent.</p>
        </div>
      )}

      {viewState.state === 'ready' && (
        <div data-testid="listener-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {viewState.data.messages.map(msg => (
            <MessageCard
              key={msg.id}
              msg={msg}
              isAcking={ackingId === msg.id}
              onAck={() => handleAck(msg.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function getSeverityClass(severity: string) {
  switch (severity) {
    case 'critical': return 'severity-critical'
    case 'warning': return 'severity-warning'
    case 'info': return 'severity-info'
    default: return 'severity-default'
  }
}

function MessageCard({ msg, isAcking, onAck }: { msg: ListenerMessage; isAcking: boolean; onAck: () => void }) {
  const isUnread = !msg.read
  
  return (
    <div
      data-testid="listener-message-card"
      className={`listener-message-card ${isUnread ? 'is-unread' : ''}`}
    >
      <div className="listener-header">
        <div className="listener-meta">
          <span
            aria-label={`Severity: ${msg.severity}`}
            className={`listener-severity ${getSeverityClass(msg.severity)}`}
          >
            {msg.severity}
          </span>
          <span className="listener-source">
            {msg.source}/{msg.kind}
          </span>
          {isUnread && (
            <span
              title="Unread"
              className="listener-unread-dot"
            >
              <span className="sr-only">Unread</span>
            </span>
          )}
        </div>
        <div className="listener-time">
          {new Date(msg.createdAt).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
          })}
        </div>
      </div>
      
      <div className="listener-body-container">
        <h3 className="listener-title">
          {msg.title}
        </h3>
        <p className="listener-body-text">
          {msg.body}
        </p>
      </div>
      
      {(msg.links.length > 0 || isUnread) && (
        <div className="listener-footer">
          <div className="listener-links">
            {msg.links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="listener-link"
              >
                {link.label} ↗
              </a>
            ))}
          </div>
          {isUnread && (
            <button
              type="button"
              className="run-cancel-btn-dismiss"
              onClick={onAck}
              disabled={isAcking}
              style={{ minHeight: '32px', padding: 'var(--space-1) var(--space-2)' }}
            >
              {isAcking ? 'Marking...' : 'Mark read'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}