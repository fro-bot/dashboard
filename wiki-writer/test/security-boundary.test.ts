import {readdir, readFile} from 'node:fs/promises'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

describe('writer security boundary', () => {
  it('keeps key loading and the write client outside dashboard source paths', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
    const sourceRoots = [join(repositoryRoot, 'src'), join(repositoryRoot, 'web', 'src')]
    const sourceFiles = (await Promise.all(sourceRoots.map(async root => listTypeScriptFiles(root)))).flat().sort()
    const forbiddenTokens = [
      {label: 'createGitHubDataClient', pattern: /\bcreateGitHubDataClient\b/gu},
      {label: 'createGitHubDataClientWithTransport', pattern: /\bcreateGitHubDataClientWithTransport\b/gu},
      {label: 'privateKeyFilePath', pattern: /\bprivateKeyFilePath\b/gu},
      {label: 'WIKI_WRITER_GITHUB_PRIVATE_KEY_FILE', pattern: /\bWIKI_WRITER_GITHUB_PRIVATE_KEY_FILE\b/gu},
      {label: 'wiki-writer import', pattern: /(?:\bfrom[ \t]+|\bimport[ \t]*\([ \t]*)["'][^"']*wiki-writer[/"]/gu},
    ]

    expect(sourceFiles.length).toBeGreaterThan(90)
    for (const filePath of sourceFiles) {
      const source = await readFile(filePath, 'utf8')
      for (const token of forbiddenTokens) {
        if (token.pattern.test(source)) {
          throw new Error(`Credential boundary violation in ${relative(repositoryRoot, filePath)}: matched ${token.label}`)
        }
        token.pattern.lastIndex = 0
      }
    }
  })
})

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(entryPath))
    } else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}
