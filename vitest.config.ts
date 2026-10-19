import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.js', 'wiki-writer/test/**/*.test.ts', '.opencode/impeccable/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist'],
  },
})
