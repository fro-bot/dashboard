/**
 * Test stub for virtual:pwa-register/react.
 *
 * The real virtual module is provided by vite-plugin-pwa at build time and is
 * not resolvable in the Vitest test environment. This stub provides the same
 * shape so components that import useRegisterSW can be tested without a real
 * service worker.
 *
 * Individual tests that need to control the hook's return value should use
 * vi.mock('virtual:pwa-register/react', ...) to override this stub.
 */

import {vi} from 'vitest'

type UseRegisterSWReturn = {
  needRefresh: [boolean, (v: boolean) => void]
  offlineReady: [boolean, (v: boolean) => void]
  updateServiceWorker: () => void
}

export const useRegisterSW: () => UseRegisterSWReturn = vi.fn(() => ({
  needRefresh: [false, vi.fn()] as [boolean, (v: boolean) => void],
  offlineReady: [false, vi.fn()] as [boolean, (v: boolean) => void],
  updateServiceWorker: vi.fn(),
}))
