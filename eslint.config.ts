import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig({
  name: '@fro-bot/dashboard',
  // AI-authored planning/solution docs (docs/plans, docs/solutions, docs/brainstorms)
  // are generated artifacts, not hand-authored source — exclude them from linting.
  ignores: ['docs/plans/**', 'docs/solutions/**', 'docs/brainstorms/**'],
  typescript: {
    tsconfigPath: './tsconfig.json',
    // Enforce Node 24 strip-only TypeScript compatibility: rejects parameter properties,
    // enums, namespaces, and import aliases at lint time, before they surface as
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime.
    erasableSyntaxOnly: true,
  },
})
