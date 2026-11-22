import {ESLint} from 'eslint'
import {describe, expect, it} from 'vitest'

describe('ESLint source coverage', () => {
  const eslint = new ESLint()
  const narrowFiles = ['web/src/App.tsx', '.opencode/impeccable/hook-bridge.integration.test.ts']
  const correctnessRules = [
    'no-debugger',
    'no-unreachable',
    'no-unsafe-finally',
    'no-dupe-keys',
    'no-duplicate-case',
    'no-constant-binary-expression',
    'no-control-regex',
  ]

  it.each([...narrowFiles, 'src/server.ts'])(
    'reports debugger in %s',
    async filePath => {
      const [result] = await eslint.lintText('debugger;', {filePath})
      expect(result?.messages).toContainEqual(expect.objectContaining({ruleId: 'no-debugger', severity: 2}))
    },
  )

  it.each(narrowFiles)('enforces the correctness rules as errors in %s', async filePath => {
    const config: unknown = await eslint.calculateConfigForFile(filePath)
    for (const rule of correctnessRules) {
      expect(config, `${filePath}: ${rule}`).toHaveProperty(['rules', rule, 0], 2)
    }
  })
})
