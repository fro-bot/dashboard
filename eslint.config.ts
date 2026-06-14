import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig({
  name: '@fro-bot/dashboard',
  typescript: {
    tsconfigPath: './tsconfig.json',
    // Enforce Node 24 strip-only TypeScript compatibility: rejects parameter properties,
    // enums, namespaces, and import aliases at lint time, before they surface as
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime.
    erasableSyntaxOnly: true,
  },
})
