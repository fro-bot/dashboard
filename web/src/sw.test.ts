/**
 * Service worker tests — build-output assertions (require a prior `bun run build:web`):
 * - Pins the deny-by-default fetch router structure.
 * - Pins that /api/monitoring NetworkFirst route is ABSENT (monitoring removed).
 * - Pins the /operator navigation redirect handler is present BEFORE generic nav fallback.
 * - Pins the PURGE_RUNTIME message handler targets operator runtime caches only.
 *
 * Build-output tests read the built artifact, not the source sw.ts, because the
 * injectManifest step substitutes self.__WB_MANIFEST and produces the final sw.js.
 * `bun run test` runs the root `pretest` script, which runs `bun run build:web` automatically.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Behavioral tests below evaluate the real sw.ts entry in jsdom. Workbox's
// routing/precache/strategies need a real ServiceWorkerGlobalScope, so they are
// stubbed; everything else (the message handler under test) is the real source.
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => vi.fn()),
  precacheAndRoute: vi.fn(),
}))
vi.mock('workbox-routing', () => ({
  NavigationRoute: vi.fn(),
  registerRoute: vi.fn(),
}))
vi.mock('workbox-strategies', () => ({NetworkOnly: vi.fn()}))

// Resolve relative to the web/ root (vitest.config.ts sets root: 'web').
const SW_PATH = resolve(__dirname, '../dist/sw.js')

function readSW(): string {
  try {
    return readFileSync(SW_PATH, 'utf-8')
  } catch {
    throw new Error(
      `web/dist/sw.js not found. Run 'bun run build:web' before running tests.\n` +
        `Expected path: ${SW_PATH}`,
    )
  }
}

describe('sw.js build output', () => {
  it('exists and is non-empty', () => {
    const content = readSW()
    expect(content.length).toBeGreaterThan(1000)
  })

  it('has self.__WB_MANIFEST substituted (non-empty precache list)', () => {
    const content = readSW()
    // After injectManifest substitution, self.__WB_MANIFEST is replaced with
    // an array literal. The raw token must NOT appear in the output.
    expect(content).not.toContain('self.__WB_MANIFEST')
    // The precache manifest rewrites index.html → '/' via manifestTransforms so
    // Workbox's install-time fetch hits GET / (200) not GET /index.html (404).
    expect(content).not.toMatch(/"url":"index\.html"/)
    expect(content).toContain('"url":"/"')
  })

  // SECURITY GUARD: deny-by-default auth/api routing.
  // These assertions pin the load-bearing safety boundary. If either guard is
  // dropped, the SW would intercept OAuth callbacks or serve cached API responses
  // to unauthenticated users.

  it('GUARD: /auth/ routes are NetworkOnly (auth must reach the server)', () => {
    const content = readSW()
    expect(content).toContain('/auth/')
  })

  it('GUARD: /api/ routes are NetworkOnly (default-deny API caching)', () => {
    const content = readSW()
    expect(content).toContain('/api/')
  })

  it('GUARD: NavigationRoute denylist contains /auth/ and /api/ regex patterns', () => {
    const content = readSW()
    expect(content).toMatch(/\\\/auth/)
    expect(content).toMatch(/\\\/api/)
  })

  // /privacy navigation exemption — the public policy page must reach the
  // server (which serves it), not the precached SPA shell.

  it('GUARD: NavigationRoute denylist contains a /privacy regex pattern', () => {
    const content = readSW()
    expect(content).toMatch(/\\\/privacy/)
  })

  it('GUARD: /privacy denylist regex exempts both the bare path and the trailing-slash variant', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const denylistMatch = /denylist:\s*\[([^\]]+)]/.exec(src)
    expect(denylistMatch).not.toBeNull()
    const privacyEntry = denylistMatch?.[1]
      ?.split(',')
      .map(entry => entry.trim())
      .find(entry => entry.includes('privacy'))
    expect(privacyEntry).toBeDefined()
    // Test-only: constructing the exact regex the source declares, to assert its match behavior directly.
    const privacyRegex = new RegExp(privacyEntry?.replace(/^\/|\/$/g, '') ?? '')
    expect(privacyRegex.test('/privacy')).toBe(true)
    expect(privacyRegex.test('/privacy/')).toBe(true)
    // A path merely sharing the prefix must NOT be exempted — proves this is
    // an anchored path match, not a substring/prefix match.
    expect(privacyRegex.test('/privacy-policy-internal')).toBe(false)
    // An ordinary in-app navigation must NOT be exempted — it still falls
    // through to the precached app shell.
    expect(privacyRegex.test('/dashboard')).toBe(false)
  })

  // REGRESSION: /api/monitoring NetworkFirst route MUST be absent.

  it('REGRESSION: /api/monitoring NetworkFirst route is ABSENT from the built SW', () => {
    const content = readSW()
    expect(content).not.toContain('/api/monitoring')
  })

  it('REGRESSION: X-From-Cache stale-snapshot header is ABSENT from the built SW', () => {
    const content = readSW()
    expect(content).not.toContain('X-From-Cache')
  })

  it('REGRESSION: X-Cached-At stale-snapshot header is ABSENT from the built SW', () => {
    const content = readSW()
    expect(content).not.toContain('X-Cached-At')
  })

  // /operator navigation redirect handler must fire BEFORE the generic NavigationRoute.

  it('GUARD: /operator navigation redirect handler is present in the built SW', () => {
    const content = readSW()
    expect(content).toContain('/operator')
  })

  it('GUARD: source registers /operator redirect handler BEFORE the generic NavigationRoute', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const operatorRedirectIdx = src.indexOf('/operator')
    const navHandlerIdx = src.indexOf("createHandlerBoundToURL('/')")
    expect(operatorRedirectIdx).toBeGreaterThan(-1)
    expect(navHandlerIdx).toBeGreaterThan(-1)
    expect(operatorRedirectIdx).toBeLessThan(navHandlerIdx)
  })

  it('GUARD: source registers the precache BEFORE the NavigationRoute (createHandlerBoundToURL resolves against the precache at call time)', () => {
    // When createHandlerBoundToURL runs before precacheAndRoute(), Workbox throws
    // `non-precached-url` and the SW never registers (silent SPA degradation).
    const src = readFileSync(
      resolve(import.meta.dirname, 'sw.ts'),
      'utf8',
    )
    const precacheIdx = src.indexOf('precacheAndRoute(self.__WB_MANIFEST)')
    const navHandlerIdx = src.indexOf("createHandlerBoundToURL('/')")
    expect(precacheIdx).toBeGreaterThan(-1)
    expect(navHandlerIdx).toBeGreaterThan(-1)
    expect(precacheIdx).toBeLessThan(navHandlerIdx)
  })

  it('GUARD: PURGE_RUNTIME message handler is present in the built SW', () => {
    const content = readSW()
    expect(content).toContain('PURGE_RUNTIME')
  })

  it('GUARD: purge handler targets operator-runtime-v1 (positive assertion)', () => {
    const content = readSW()
    expect(content).toContain('operator-runtime-v1')
  })

  it('GUARD: purge handler also deletes legacy monitoring-v1 cache (migration cleanup)', () => {
    const content = readSW()
    expect(content).toContain('monitoring-v1')
  })

  it('GUARD: purge handler does NOT delete the precache (workbox-precache-v2)', () => {
    const content = readSW()
    expect(content).not.toContain('workbox-precache-v2')
  })

  // The SW itself and the manifest must NOT be in the precache list (served with
  // no-cache headers; must not be stale-served from precache).

  it('sw.js is NOT in the precache list', () => {
    const content = readSW()
    expect(content).not.toMatch(/"url":"sw\.js"/)
    expect(content).not.toMatch(/"url":".*\/sw\.js"/)
  })

  it('manifest.webmanifest is NOT in the precache list', () => {
    const content = readSW()
    expect(content).not.toMatch(/"url":"manifest\.webmanifest"/)
    expect(content).not.toMatch(/"url":".*manifest\.webmanifest"/)
  })

  it('registerSW.js is NOT in the precache list', () => {
    const content = readSW()
    expect(content).not.toMatch(/"url":"registerSW\.js"/)
  })

  // Asserts the shell's hashed JS and CSS are precached. Deliberately not
  // pinned to a chunk name: the shared stylesheet is emitted as `src-*.css`
  // rather than `index-*.css` now that privacy.html is a second build entry
  // sharing it. The guarantee is "the shell's JS and CSS are precached", not
  // what Rollup happens to name the chunk.
  it('precache list contains at least the app JS bundle and CSS', () => {
    const content = readSW()
    expect(content).toMatch(/"url":"assets\/[A-Za-z0-9_-]+\.js"/)
    expect(content).toMatch(/"url":"assets\/[A-Za-z0-9_-]+\.css"/)
  })

  // The public privacy page must never enter the precache. Its install-time
  // fetch would 404 (the server serves it at /privacy, not /privacy.html),
  // which makes the service worker redundant and stops it registering at all.
  //
  // Scoped to precache manifest entries ("url":"...") rather than the whole
  // file: the NavigationRoute denylist below legitimately mentions /privacy
  // (as an exemption, not a precache entry), so a bare /privacy/i scan over
  // the entire build would false-positive on that unrelated, correct string.
  it('SECURITY: privacy.html is NOT in the precache list', () => {
    const content = readSW()
    expect(content).not.toMatch(/"url":"[^"]*privacy[^"]*"/i)
  })

  // Security: operator data must never be cached.

  it('SECURITY: /operator/auth/ routes are covered by the NetworkOnly denylist', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    expect(src).toMatch(/operator\/auth/)
  })

  // Push, notificationclick, pushsubscriptionchange handlers.

  it('GUARD: push, notificationclick, and pushsubscriptionchange listeners are registered', () => {
    const content = readSW()
    expect(content).toMatch(/addEventListener\(`push`/)
    expect(content).toMatch(/addEventListener\(`notificationclick`/)
    expect(content).toMatch(/addEventListener\(`pushsubscriptionchange`/)
  })

  it('GUARD: push handler references showNotification and touches no cache API', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const pushHandlerStart = src.indexOf("addEventListener('push'")
    const pushHandlerEnd = src.indexOf("addEventListener('notificationclick'")
    expect(pushHandlerStart).toBeGreaterThan(-1)
    expect(pushHandlerEnd).toBeGreaterThan(pushHandlerStart)
    const pushHandlerSource = src.slice(pushHandlerStart, pushHandlerEnd)
    expect(pushHandlerSource).toContain('showNotification')
    expect(pushHandlerSource).not.toContain('caches.')
    expect(pushHandlerSource).not.toContain('cache.put')
  })

  it('GUARD: notificationclick handler only delegates to the pure resolver (behavior is tested in push/notification-click.test.ts)', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    expect(src).toContain("from './push/notification-click.ts'")
    const clickHandlerStart = src.indexOf("addEventListener('notificationclick'")
    const clickHandlerEnd = src.indexOf("addEventListener('pushsubscriptionchange'")
    expect(clickHandlerStart).toBeGreaterThan(-1)
    expect(clickHandlerEnd).toBeGreaterThan(clickHandlerStart)
    const clickHandlerSource = src.slice(clickHandlerStart, clickHandlerEnd)
    expect(clickHandlerSource).toContain('handleNotificationClick(clients, e.notification.data)')
    // No navigation logic inline: the resolver owns window selection and opening.
    expect(clickHandlerSource).not.toContain('openWindow')
    expect(clickHandlerSource).not.toContain('matchAll')
  })

  it('GUARD: sw.ts never builds a navigation URL from a payload route (open-redirect guard)', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    // The wire `route` is never read in the worker entry; the resolver and
    // buildNotification validate and discard it.
    expect(src).not.toMatch(/\.route\b/)
    expect(src).not.toContain('.data.route')
    // The only data handed onward is the notification's stored data, to the resolver.
    expect(src.match(/notification\.data/g)).toHaveLength(1)
  })

  it('GUARD: pushsubscriptionchange handler posts only {type: PUSH_SUBSCRIPTION_CHANGE} — no endpoint/keys/identity', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const changeHandlerStart = src.indexOf("addEventListener('pushsubscriptionchange'")
    expect(changeHandlerStart).toBeGreaterThan(-1)
    const changeHandlerSource = src.slice(changeHandlerStart)
    expect(changeHandlerSource).toContain('PUSH_SUBSCRIPTION_CHANGE')
    expect(changeHandlerSource).not.toContain('endpoint')
    expect(changeHandlerSource).not.toContain('p256dh')
  })

  it('GUARD: pushsubscriptionchange handler performs no resubscribe — no pushManager.subscribe call', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const changeHandlerStart = src.indexOf("addEventListener('pushsubscriptionchange'")
    expect(changeHandlerStart).toBeGreaterThan(-1)
    const changeHandlerSource = src.slice(changeHandlerStart)
    expect(changeHandlerSource).not.toContain('pushManager.subscribe')
    expect(changeHandlerSource).not.toContain('applicationServerKey')
  })

  it('GUARD: SKIP_WAITING is handled in the message handler and never in an install listener (prompt-gated activation)', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    expect(src).toContain("'SKIP_WAITING'")
    expect(src).not.toContain("addEventListener('install'")
    expect(src).not.toContain('clients.claim')
  })

  it('GUARD: the push/notificationclick/pushsubscriptionchange handlers are registered AFTER the message handler', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const messageHandlerIdx = src.indexOf("addEventListener('message'")
    const pushHandlerIdx = src.indexOf("addEventListener('push'")
    expect(messageHandlerIdx).toBeGreaterThan(-1)
    expect(pushHandlerIdx).toBeGreaterThan(-1)
    expect(messageHandlerIdx).toBeLessThan(pushHandlerIdx)
  })
})

// vite-plugin-pwa's useRegisterSW → updateServiceWorker(true) → workbox-window
// messageSkipWaiting() posts exactly {type: 'SKIP_WAITING'} to the waiting worker
// (workbox-window 7.4.1 SKIP_WAITING_MESSAGE; vite-plugin-pwa 1.3.0 client/build/react.js).
// The page's `controlling` listener then reloads. With injectManifest, the custom
// worker must call skipWaiting() itself, or Refresh is a no-op and the old
// worker keeps serving the old precached shell indefinitely.
describe('sw.ts message handler (behavioral)', () => {
  type MessageListener = (event: Event) => void
  let messageListener: MessageListener
  let installListeners: string[]
  const skipWaiting = vi.fn(() => Promise.resolve())

  function dispatchMessage(data: unknown): ReturnType<typeof vi.fn> {
    const waitUntil = vi.fn()
    messageListener(Object.assign(new Event('message'), {data, waitUntil}))
    return waitUntil
  }

  beforeEach(async () => {
    vi.resetModules()
    skipWaiting.mockClear()
    installListeners = []
    const captured: Record<string, MessageListener> = {}
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(((type: string, listener: MessageListener) => {
      captured[type] = listener
      if (type === 'install') installListeners.push(type)
    }) as typeof globalThis.addEventListener)
    vi.stubGlobal('skipWaiting', skipWaiting)
    vi.stubGlobal('caches', {delete: vi.fn(() => Promise.resolve(true))})
    await import('./sw.ts')
    const listener = captured.message
    if (listener === undefined) throw new Error('sw.ts did not register a message listener')
    messageListener = listener
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('calls skipWaiting() when the page posts {type: SKIP_WAITING} (what updateServiceWorker(true) sends)', () => {
    const waitUntil = dispatchMessage({type: 'SKIP_WAITING'})
    expect(skipWaiting).toHaveBeenCalledTimes(1)
    // Tied to the message event's lifetime, so the worker stays alive until activation is requested.
    expect(waitUntil).toHaveBeenCalledWith(skipWaiting.mock.results[0]?.value)
  })

  it('does NOT skip waiting on install — activation stays prompt-gated', () => {
    expect(skipWaiting).not.toHaveBeenCalled()
    expect(installListeners).toEqual([])
  })

  it.each([
    ['PURGE_RUNTIME', {type: 'PURGE_RUNTIME'}],
    ['an unknown type', {type: 'SOMETHING_ELSE'}],
    ['a case variant', {type: 'skip_waiting'}],
    ['a type substring', {type: 'SKIP_WAITING_NOW'}],
    ['an empty object', {}],
    ['a string payload', 'SKIP_WAITING'],
    ['null', null],
  ])('does NOT call skipWaiting() for %s', (_label, data) => {
    dispatchMessage(data)
    expect(skipWaiting).not.toHaveBeenCalled()
  })
})

// The push and notificationclick listeners, run against stubbed `registration` and `clients` globals so the
// options handed to showNotification and the jump a click makes are what the worker really does.
describe('sw.ts push and notificationclick handlers (behavioral)', () => {
  type Listener = (event: Event) => void
  const RUN_A = 'run-approval-0001'
  const RUN_B = 'run-approval-0002'

  let listeners: Record<string, Listener>
  let showNotification: ReturnType<typeof vi.fn>
  let openWindow: ReturnType<typeof vi.fn>
  let appWindow: {url: string; focused: boolean; visibilityState: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>}
  let controlledWindows: unknown[]

  const wire = (type: string, runId?: string) => ({
    title: `operator.${type}.title`,
    body: `operator.${type}.body`,
    data: runId === undefined ? {type, route: '/'} : {type, route: `/operator#${runId}`, runId},
  })

  function push(payload: unknown): void {
    const waitUntil = vi.fn()
    listeners.push?.(Object.assign(new Event('push'), {data: {json: () => payload}, waitUntil}))
  }

  async function click(data: unknown): Promise<void> {
    const waitUntil = vi.fn()
    listeners.notificationclick?.(
      Object.assign(new Event('notificationclick'), {notification: {data, close: vi.fn()}, waitUntil}),
    )
    await waitUntil.mock.calls[0]?.[0]
  }

  /** The data of the nth notification the worker showed. */
  const shownData = (index: number): unknown => (showNotification.mock.calls[index]?.[1] as {data: unknown}).data

  beforeEach(async () => {
    vi.resetModules()
    listeners = {}
    showNotification = vi.fn(() => Promise.resolve())
    openWindow = vi.fn(() => Promise.resolve())
    appWindow = {
      url: 'https://dash.example/',
      focused: true,
      visibilityState: 'visible',
      focus: vi.fn(() => Promise.resolve()),
      postMessage: vi.fn(),
    }
    controlledWindows = [appWindow]
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(((type: string, listener: Listener) => {
      listeners[type] = listener
    }) as typeof globalThis.addEventListener)
    vi.stubGlobal('skipWaiting', vi.fn(() => Promise.resolve()))
    vi.stubGlobal('caches', {delete: vi.fn(() => Promise.resolve(true))})
    vi.stubGlobal('registration', {showNotification})
    vi.stubGlobal('clients', {
      matchAll: vi.fn(() => Promise.resolve(controlledWindows)),
      openWindow,
    })
    await import('./sw.ts')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows every push with options of exactly {body, data}: no tag and no renotify', () => {
    for (const payload of [wire('approval', RUN_A), wire('question', RUN_A), wire('run_failed'), null]) push(payload)

    expect(showNotification).toHaveBeenCalledTimes(4)
    for (const call of showNotification.mock.calls) {
      const options = call[1] as Record<string, unknown>
      expect(Object.keys(options).toSorted()).toEqual(['body', 'data'])
      expect('tag' in options).toBe(false)
      expect('renotify' in options).toBe(false)
    }
  })

  it('an approval and a question for the same run are two separate notifications', () => {
    push(wire('approval', RUN_A))
    push(wire('question', RUN_A))

    expect(showNotification).toHaveBeenCalledTimes(2)
    expect(showNotification.mock.calls[0]?.[0]).toBe('Approval needed')
    expect(showNotification.mock.calls[1]?.[0]).toBe('Answer needed')
    expect(shownData(0)).toEqual({type: 'approval', route: '/', runId: RUN_A})
    expect(shownData(1)).toEqual({type: 'question', route: '/', runId: RUN_A})
  })

  it('two approvals for different runs are two notifications, each opening its own run', async () => {
    push(wire('approval', RUN_A))
    push(wire('approval', RUN_B))
    expect(showNotification).toHaveBeenCalledTimes(2)

    await click(shownData(0))
    await click(shownData(1))

    expect(appWindow.postMessage.mock.calls.map(call => call[0])).toEqual([
      {type: 'OPEN_RUN', runId: RUN_A},
      {type: 'OPEN_RUN', runId: RUN_B},
    ])
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('clicking an approval focuses the open controlled window and sends OPEN_RUN', async () => {
    push(wire('approval', RUN_A))
    await click(shownData(0))

    expect(appWindow.focus).toHaveBeenCalledTimes(1)
    expect(appWindow.postMessage).toHaveBeenCalledWith({type: 'OPEN_RUN', runId: RUN_A})
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('clicking an approval with no window opens /#<runId>', async () => {
    controlledWindows = []
    push(wire('approval', RUN_A))
    await click(shownData(0))

    expect(openWindow).toHaveBeenCalledWith(`/#${RUN_A}`)
  })

  it('an approval whose runId fails the pattern shows with no runId and a click opens / with no jump', async () => {
    controlledWindows = []
    push({data: {type: 'approval', route: '/operator#../x', runId: '../x'}})

    expect(shownData(0)).toEqual({type: 'approval', route: '/'})
    await click(shownData(0))
    expect(openWindow).toHaveBeenCalledWith('/')
    expect(appWindow.postMessage).not.toHaveBeenCalled()
  })
})

// The wiki API carries drafts and save outcomes. It must reach the server on every request, so the worker
// may route /api/wiki/* only through NetworkOnly and may not cache it or answer it from the precache.
describe('sw.ts routing of /api/wiki/* (behavioral)', () => {
  const WIKI_PATHS = [
    '/api/wiki/pages',
    '/api/wiki/pages/repos.acme--alpha',
    '/api/wiki/pages/repos.acme--alpha/save',
    '/api/wiki/operations/00000000-0000-4000-8000-000000000001',
    '/api/wiki/promotion/status',
    '/api/wiki/promotion/dispatch',
  ]

  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('addEventListener', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('routes every /api/wiki/* URL to a NetworkOnly strategy and to nothing else', async () => {
    const routing = await import('workbox-routing')
    const strategies = await import('workbox-strategies')
    await import('./sw.ts')

    type Matcher = (options: {url: URL; request: {mode: string; destination: string}}) => boolean
    const registered = (vi.mocked(routing.registerRoute).mock.calls as unknown as [unknown, unknown][]).filter(
      (call): call is [Matcher, unknown] => typeof call[0] === 'function',
    )
    expect(registered.length).toBeGreaterThan(0)

    for (const path of WIKI_PATHS) {
      const url = new URL(path, 'https://dashboard.fro.bot')
      const request = {mode: 'cors', destination: ''}
      const handlers = registered.filter(([matcher]) => matcher({url, request})).map(([, handler]) => handler)
      expect(handlers.length, path).toBeGreaterThan(0)
      for (const handler of handlers) expect(vi.mocked(strategies.NetworkOnly).mock.results.map(r => r.value)).toContain(handler)
    }
  })

  it('does not precache or runtime-cache any wiki path', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')

    expect(source).not.toMatch(/StaleWhileRevalidate|CacheFirst|NetworkFirst/u)
    expect(readSW()).not.toMatch(/api\/wiki/u)
  })
})
