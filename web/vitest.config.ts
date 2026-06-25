import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import {defineConfig} from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'web',
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // vite-plugin-pwa virtual modules are not resolvable in the test environment.
    // Alias them to stub files so tests that import components using useRegisterSW
    // don't fail with "Cannot find module 'virtual:pwa-register/react'".
    alias: {
      'virtual:pwa-register/react': new URL('./src/pwa/__mocks__/virtual-pwa-register-react.ts', import.meta.url).pathname,
    },
  },
})
