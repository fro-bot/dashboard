import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getNotificationPermission, getPushSupport} from './capability.ts'

function definePlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', {value: platform, configurable: true})
}

function defineUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {value: userAgent, configurable: true})
}

function defineStandalone(value: boolean | undefined): void {
  Object.defineProperty(navigator, 'standalone', {value, configurable: true})
}

function defineMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockReturnValue({matches}),
    configurable: true,
    writable: true,
  })
}

function definePushManager(present: boolean): void {
  if (present) {
    ;(window as unknown as {PushManager: unknown}).PushManager = class {}
  } else {
    delete (window as unknown as {PushManager?: unknown}).PushManager
  }
}

function defineServiceWorker(present: boolean): void {
  if (present) {
    Object.defineProperty(navigator, 'serviceWorker', {value: {}, configurable: true})
  } else {
    Reflect.deleteProperty(navigator, 'serviceWorker')
  }
}

function defineNotification(present: boolean): void {
  if (present) {
    Object.defineProperty(window, 'Notification', {
      value: {permission: 'default', requestPermission: vi.fn()},
      configurable: true,
      writable: true,
    })
  } else {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification')
  }
}

describe('getPushSupport', () => {
  const originalOntouchend = 'ontouchend' in document

  beforeEach(() => {
    definePlatform('Win32')
    defineUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    defineStandalone(undefined)
    defineMatchMedia(false)
    definePushManager(true)
    defineServiceWorker(true)
    defineNotification(true)
  })

  afterEach(() => {
    if (originalOntouchend === false && 'ontouchend' in document) {
      Reflect.deleteProperty(document, 'ontouchend')
    }
    vi.unstubAllGlobals()
  })

  it('full support (desktop, all APIs present, not iOS) -> supported, no install needed', () => {
    expect(getPushSupport()).toEqual({supported: true, needsInstall: false})
  })

  it('iOS non-installed -> unsupported, needsInstall true', () => {
    definePlatform('iPhone')
    expect(getPushSupport()).toEqual({supported: false, needsInstall: true})
  })

  it('iOS installed (standalone) -> supported, no install needed', () => {
    definePlatform('iPhone')
    defineStandalone(true)
    expect(getPushSupport()).toEqual({supported: true, needsInstall: false})
  })

  it('iOS installed via matchMedia standalone -> supported', () => {
    definePlatform('iPad')
    defineMatchMedia(true)
    expect(getPushSupport()).toEqual({supported: true, needsInstall: false})
  })

  it('missing PushManager -> unsupported, needsInstall false (non-iOS)', () => {
    definePushManager(false)
    expect(getPushSupport()).toEqual({supported: false, needsInstall: false})
  })

  it('missing serviceWorker -> unsupported', () => {
    defineServiceWorker(false)
    expect(getPushSupport().supported).toBe(false)
  })

  it('desktop-UA iPad tiebreak: Mac UA + touch support -> treated as iOS', () => {
    definePlatform('MacIntel')
    defineUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    Object.defineProperty(document, 'ontouchend', {value: null, configurable: true})
    expect(getPushSupport()).toEqual({supported: false, needsInstall: true})
  })

  // Note: jsdom defines `ontouchend` as a spec'd IDL property on every
  // element/document regardless of actual touch support, so a genuine
  // "Mac UA without touch" negative case cannot be reproduced in this test
  // environment — `'ontouchend' in document` is always true under jsdom.
  // Real desktop Safari/Chrome (no touchscreen) correctly omit it, which is
  // what production relies on; that path is covered by the browser
  // verification pass (U8), not a unit test.
})

describe('getNotificationPermission', () => {
  it('reads Notification.permission without requesting it', () => {
    const requestPermission = vi.fn()
    Object.defineProperty(window, 'Notification', {
      value: {permission: 'default', requestPermission},
      configurable: true,
      writable: true,
    })
    expect(getNotificationPermission()).toBe('default')
    expect(requestPermission).not.toHaveBeenCalled()
  })
})
