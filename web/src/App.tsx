import {useEffect, useState, useCallback} from 'react'
import {flushSync} from 'react-dom'
import {requestRunJump} from './operator/runtime.ts'
import {parseOpenRunMessage} from './push/open-run-message.ts'
import {AppShell, type AppView} from './shell/AppShell.tsx'
import {Operator} from './views/Operator.tsx'
import {ListenerChannel} from './views/Listener.tsx'
import {WikiEditor} from './views/WikiEditor.tsx'
import {WikiList} from './views/WikiList.tsx'
import {confirmLeaveWiki, restoreGuardedPage} from './wiki/navigation-guard.ts'
import {
  currentWikiRoute,
  leaveWikiUrl,
  onWikiPopState,
  pushWikiPage,
  seedWikiHistory,
  showWikiList,
} from './wiki/location.ts'
import {fetchListenerMessages} from './api/listener.ts'
import type {OperatorState} from './operator/state.ts'

interface FixtureState {
  readonly fixtureMode: true
  readonly fixtureEndpointBase: string
  readonly fixtureSessionId: string
}

export default function App() {
  const [operatorState, setOperatorState] = useState<OperatorState>('ready')
  const [fixtureState, setFixtureState] = useState<FixtureState | null>(null)
  const [fixtureDetectionSettled, setFixtureDetectionSettled] = useState(!import.meta.env.DEV)
  
  // There is no router. A load on /wiki opens the list and a load on /wiki/<id> opens that page; the
  // URL is read once, here.
  const [wikiPageId, setWikiPageId] = useState<string | null>(() => {
    const route = currentWikiRoute()
    return route.kind === 'page' ? route.id : null
  })
  const [currentView, setCurrentView] = useState<AppView>(() => (currentWikiRoute().kind === 'other' ? 'operator' : 'wiki'))
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
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

  const pollUnreadCount = useCallback(async () => {
    const res = await fetchListenerMessages({ limit: 1, unreadOnly: true })
    if (res.ok) {
      setUnreadCount(res.data.unreadCount)
    }
  }, [])

  useEffect(() => {
    void pollUnreadCount()
    const intervalId = setInterval(() => void pollUnreadCount(), 30000)
    
    const handleFocus = () => void pollUnreadCount()
    window.addEventListener('focus', handleFocus)
    
    return () => {
      clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
    }
  }, [pollUnreadCount])

  // Show a view. Only the wiki owns a URL: /wiki for the list, /wiki/<id> for a page. Leaving it pushes
  // back the URL the operator view had, hash included, and the Wiki entry always lands on the list.
  // A wiki page with unsaved edits holds a navigation guard: the operator is asked first, and a refusal
  // changes nothing (returns false). The list link, the nav, and the OPEN_RUN handler all come through here.
  const showView = useCallback((view: AppView): boolean => {
    if (!confirmLeaveWiki(null)) return false
    if (view === 'wiki') showWikiList()
    else leaveWikiUrl()
    setWikiPageId(null)
    setCurrentView(view)
    return true
  }, [])

  const openWikiPage = useCallback((pageId: string) => {
    if (!confirmLeaveWiki({kind: 'page', id: pageId})) return
    if (!pushWikiPage(pageId)) return
    setWikiPageId(pageId)
  }, [])

  // Back and Forward. A /wiki/<id> entry opens that page and /wiki opens the list. Any other entry
  // leaves the wiki for the operator view, and leaves every non-wiki view where it is (a hash change
  // also fires popstate). The URL has already moved by the time this runs, so a move the guard refuses
  // is undone by putting the guarded page's URL back.
  useEffect(() => {
    seedWikiHistory()
    return onWikiPopState(route => {
      if (!confirmLeaveWiki(route)) {
        restoreGuardedPage()
        return
      }
      if (route.kind === 'other') {
        setWikiPageId(null)
        setCurrentView(view => (view === 'wiki' ? 'operator' : view))
        return
      }
      setWikiPageId(route.kind === 'page' ? route.id : null)
      setCurrentView('wiki')
    })
  }, [])

  // A tapped question notification: the service worker posts {type: 'OPEN_RUN', runId} to this
  // window. One listener for the App's lifetime. The message is acted on only when ALL hold:
  //   - `event.source` is `navigator.serviceWorker.controller`, the worker controlling this page.
  //     It is read when the message arrives, is synchronous and compared by identity, and a page
  //     with no controller (not yet claimed) ignores the message — it fails closed. The
  //     registration's `active` worker would need an async lookup and could name a worker that
  //     does not control this page;
  //   - the body is exactly {type: 'OPEN_RUN', runId} with a runId matching the run ID pattern.
  // Everything else is ignored silently (no console: a run ID must never be logged). The view is
  // switched first (flushed, so the operator view is showing when the runtime scrolls and focuses
  // the card), then the run is handed to the runtime's jump slot.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const container = navigator.serviceWorker

    const handleMessage = (event: MessageEvent) => {
      const controller = container.controller
      if (controller === null || controller === undefined || event.source !== controller) return
      const message = parseOpenRunMessage(event.data)
      if (message === null) return
      let left = false
      flushSync(() => {
        left = showView('operator')
      })
      // A refused leave (unsaved wiki edits) keeps the wiki view, so there is no run view to jump in.
      if (!left) return
      requestRunJump(message.runId)
    }

    container.addEventListener('message', handleMessage)
    return () => container.removeEventListener('message', handleMessage)
  }, [showView])

  return (
    <AppShell
      pushEndpointBase={fixtureState ? `${fixtureState.fixtureEndpointBase}/push` : undefined}
      pushConfigReady={fixtureDetectionSettled}
      pushFixtureSessionId={fixtureState?.fixtureSessionId}
      currentView={currentView}
      onNavigate={showView}
      listenerUnreadCount={unreadCount}
    >
      <div style={{ display: currentView === 'operator' ? 'block' : 'none' }}>
        <Operator
          state={fixtureDetectionSettled ? operatorState : 'loading'}
          onRuntimeStateChange={setOperatorState}
          fixtureMode={fixtureState?.fixtureMode}
          fixtureEndpointBase={fixtureState?.fixtureEndpointBase}
          fixtureSessionId={fixtureState?.fixtureSessionId}
        />
      </div>
      
      {currentView === 'listener' && (
        <ListenerChannel />
      )}

      {currentView === 'wiki' && (
        wikiPageId === null
          ? <WikiList onOpenPage={openWikiPage} />
          : <WikiEditor key={wikiPageId} pageId={wikiPageId} onBackToList={() => showView('wiki')} />
      )}
    </AppShell>
  )
}
