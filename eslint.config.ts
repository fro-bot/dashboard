import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig({
  name: '@fro-bot/dashboard',
  // AI-authored planning/solution docs (docs/plans, docs/solutions, docs/brainstorms)
  // are generated artifacts, not hand-authored source — exclude them from linting.
  // web/ is a Vite+React workspace with its own tsconfig — exclude it from the
  // backend's erasableSyntaxOnly config (full TS is valid there via Vite build).
  ignores: ['docs/plans/**', 'docs/solutions/**', 'docs/brainstorms/**', 'web/**'],
  typescript: {
    tsconfigPath: './tsconfig.json',
    // Enforce Node 24 strip-only TypeScript compatibility: rejects parameter properties,
    // enums, namespaces, and import aliases at lint time, before they surface as
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime.
    erasableSyntaxOnly: true,
  },
})
