import {readFile} from 'node:fs/promises'
import {describe, expect, it} from 'vitest'

describe('writer security boundary', () => {
  it('keeps key loading and the write client outside dashboard source paths', async () => {
    const source = [
      await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8'),
      await readFile(new URL('../../src/secrets.ts', import.meta.url), 'utf8'),
    ].join('\n')

    expect(source).not.toContain('createGitHubDataClient')
    expect(source).not.toContain('privateKeyFilePath')
    expect(source).not.toContain('WIKI_WRITER_GITHUB_PRIVATE_KEY_FILE')
  })
})
