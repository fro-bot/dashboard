import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    // Only run this app's tests. Exclude vendored dependency source under
    // .slim/clonedeps (those repos carry their own tests + workspace deps that
    // are unresolvable here).
    include: ['test/**/*.test.ts', 'test/**/*.test.js', 'wiki-writer/test/**/*.test.ts', '.opencode/impeccable/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist', '.slim'],
  },
})
