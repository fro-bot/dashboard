import type {Linter} from 'eslint'
import {defineConfig} from '@bfra.me/eslint-config'
import tseslint from 'typescript-eslint'

const narrowTrees = ['web/**', '.opencode/**']

const backendConfig = await defineConfig(
  {
    name: '@fro-bot/dashboard',
    // AI-authored planning/solution docs (docs/plans, docs/solutions, docs/brainstorms)
    // are generated artifacts, not hand-authored source — exclude them from linting.
    // .agents/ is a vendored shared-skill bundle (e.g. .agents/skills/impeccable) of
    // third-party .mjs/.md files — not our source; linting it reports tens of thousands
    // of errors.
    ignores: [
      'docs/plans/**',
      'docs/solutions/**',
      'docs/brainstorms/**',
      '.agents/**',
    ],
    typescript: {
      tsconfigPath: './tsconfig.json',
      // Enforce Node 24 strip-only TypeScript compatibility: rejects parameter properties,
      // enums, namespaces, and import aliases at lint time, before they surface as
      // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime.
      erasableSyntaxOnly: true,
    },
  },
  {
    // operator-runtime.test.ts lives in test/ but requires DOM types (jsdom environment).
    // It is excluded from the root tsconfig (no DOM lib) and covered by web/tsconfig.json.
    // Override the parser project for this file so ESLint resolves it correctly.
    files: ['test/operator-runtime.test.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: false,
        project: './web/tsconfig.json',
      },
    },
  },
)

const config: Linter.Config[] = [
  // Keep global ignores global; scope every other inherited config away from the
  // Vite and OpenCode trees, which must not inherit backend type/style rules.
  ...backendConfig.map(config =>
    Object.keys(config).every(key => key === 'name' || key === 'ignores')
      ? config
      : {...config, ignores: [...(config.ignores ?? []), ...narrowTrees]},
  ),
  {
    name: '@fro-bot/dashboard/narrow-correctness',
    files: ['{web,.opencode}/**/*.?([cm])[jt]s?(x)'],
    languageOptions: {parser: tseslint.parser},
    rules: {
      'no-debugger': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-constant-binary-expression': 'error',
      'no-control-regex': 'error',
    },
  },
]

export default config
