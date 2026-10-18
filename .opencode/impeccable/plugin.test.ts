import { describe, expect, it } from 'vitest'

import {
  bareToolName,
  buildHookPayload,
  createHook,
  extractFeedbackText,
  extractTouchedPaths,
  isMutatingTool,
  type DetectorRunResult,
} from './hook-bridge.ts'

function makeOutput(initial = 'ok') {
  return { title: 't', output: initial, metadata: {} }
}

function makeInput(overrides: Partial<{ tool: string; sessionID: string; callID: string; args: unknown }> = {}) {
  return {
    tool: 'edit',
    sessionID: 'sess-1',
    callID: 'call-1',
    args: { filePath: '/repo/web/src/App.tsx' },
    ...overrides,
  }
}

describe('isMutatingTool', () => {
  it('is true for bare mutating tool names', () => {
    expect(isMutatingTool('edit')).toBe(true)
    expect(isMutatingTool('write')).toBe(true)
    expect(isMutatingTool('apply_patch')).toBe(true)
  })

  it('is true for MCP-namespaced suffixed tool names', () => {
    expect(isMutatingTool('aft_edit')).toBe(true)
    expect(isMutatingTool('x_write')).toBe(true)
    expect(isMutatingTool('aft_apply_patch')).toBe(true)
  })

  it('is false for non-mutating tools', () => {
    expect(isMutatingTool('read')).toBe(false)
    expect(isMutatingTool('bash')).toBe(false)
    expect(isMutatingTool('grep')).toBe(false)
  })
})

describe('extractTouchedPaths', () => {
  it('pulls filePath from edit/write args', () => {
    expect(extractTouchedPaths('edit', { filePath: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(extractTouchedPaths('write', { filePath: '/a/c.ts' })).toEqual(['/a/c.ts'])
  })

  it('parses Add/Update/Delete/Move marker lines from apply_patch patchText', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+content',
      '*** Update File: b.ts',
      '*** Delete File: c.ts',
      '*** Move to: d.ts',
      '*** End Patch',
    ].join('\n')
    expect(extractTouchedPaths('apply_patch', { patchText })).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
  })

  it('returns [] for missing/empty args', () => {
    expect(extractTouchedPaths('edit', undefined)).toEqual([])
    expect(extractTouchedPaths('edit', null)).toEqual([])
    expect(extractTouchedPaths('edit', {})).toEqual([])
    expect(extractTouchedPaths('apply_patch', {})).toEqual([])
    expect(extractTouchedPaths('edit', 'not-an-object')).toEqual([])
  })

  it('parses marker lines for an MCP-suffixed apply_patch tool name', () => {
    const patchText = '*** Add File: a.ts\n*** Update File: b.ts\n'
    expect(extractTouchedPaths('aft_apply_patch', { patchText })).toEqual(['a.ts', 'b.ts'])
  })
})

describe('bareToolName', () => {
  it('passes bare mutating and non-mutating names through unchanged', () => {
    expect(bareToolName('edit')).toBe('edit')
    expect(bareToolName('write')).toBe('write')
    expect(bareToolName('apply_patch')).toBe('apply_patch')
    expect(bareToolName('read')).toBe('read')
  })

  it('strips MCP namespace prefixes', () => {
    expect(bareToolName('aft_edit')).toBe('edit')
    expect(bareToolName('x_apply_patch')).toBe('apply_patch')
  })
})

describe('buildHookPayload', () => {
  it('produces the exact field names hook.mjs reads for a representative edit event', () => {
    const payload = buildHookPayload({
      tool: 'edit',
      args: { filePath: '/repo/web/src/App.tsx' },
      cwd: '/repo',
      sessionID: 'sess-1',
    })
    expect(payload).toEqual({
      tool_name: 'edit',
      tool_input: { file_path: '/repo/web/src/App.tsx' },
      cwd: '/repo',
      session_id: 'sess-1',
    })
  })

  it('normalizes an MCP-suffixed edit tool_name to bare and keeps file_path', () => {
    const payload = buildHookPayload({
      tool: 'aft_edit',
      args: { filePath: '/repo/web/src/App.tsx' },
      cwd: '/repo',
      sessionID: 'sess-1',
    })
    expect(payload.tool_name).toBe('edit')
    expect(payload.tool_input).toEqual({ file_path: '/repo/web/src/App.tsx' })
  })

  it('sets tool_input.command to the patch text for apply_patch (no file_path)', () => {
    const patchText = '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch'
    const payload = buildHookPayload({
      tool: 'apply_patch',
      args: { patchText },
      cwd: '/repo',
      sessionID: 'sess-1',
    })
    expect(payload.tool_name).toBe('apply_patch')
    expect(payload.tool_input).toEqual({ command: patchText })
  })

  it('sets tool_input.command to the patch text for an MCP-suffixed apply_patch tool_name', () => {
    const patchText = '*** Begin Patch\n*** Update File: b.ts\n*** End Patch'
    const payload = buildHookPayload({
      tool: 'aft_apply_patch',
      args: { patchText },
      cwd: '/repo',
      sessionID: 'sess-1',
    })
    expect(payload.tool_name).toBe('apply_patch')
    expect(payload.tool_input).toEqual({ command: patchText })
  })

  it('falls back to empty string values when args are empty', () => {
    expect(buildHookPayload({ tool: 'edit', args: {}, cwd: '/r', sessionID: 's' }).tool_input).toEqual({
      file_path: '',
    })
    expect(buildHookPayload({ tool: 'apply_patch', args: {}, cwd: '/r', sessionID: 's' }).tool_input).toEqual({
      command: '',
    })
  })
})

function envelope(additionalContext: string, hookEventName = 'PostToolUse'): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })
}

function ok(stdout = '', stderr = ''): DetectorRunResult {
  return { kind: 'ok', stdout, stderr }
}

function fakeRunner(result: DetectorRunResult | Error, calls: unknown[][] = []) {
  return async (...args: unknown[]) => {
    calls.push(args)
    if (result instanceof Error) throw result
    return result
  }
}

describe('bridge (createHook)', () => {
  it('invokes the runner once with the file path in the payload for a mutating tool', async () => {
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(), calls),
      worktree: '/repo',
    })
    await hook(makeInput(), makeOutput())
    expect(calls).toHaveLength(1)
    const [payload] = calls[0] as [ReturnType<typeof buildHookPayload>]
    expect(payload.tool_input).toEqual({ file_path: '/repo/web/src/App.tsx' })
  })

  it('invokes the runner zero times for a non-mutating tool', async () => {
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(), calls),
      worktree: '/repo',
    })
    await hook(makeInput({ tool: 'read' }), makeOutput())
    expect(calls).toHaveLength(0)
  })

  it('invokes the runner zero times when no path can be extracted', async () => {
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(), calls),
      worktree: '/repo',
    })
    await hook(makeInput({ args: {} }), makeOutput())
    expect(calls).toHaveLength(0)
  })

  it('warns once, without throwing, when the runner reports a timeout', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ kind: 'timeout', stdout: '', stderr: '' }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await expect(hook(makeInput(), output)).resolves.toBeUndefined()
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('timed out')

    const second = makeOutput()
    await hook(makeInput(), second)
    expect(second.output).toBe('ok')
  })

  it('warns, without throwing, when the runner reports a spawn error', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ kind: 'spawn-error', message: 'spawn node ENOENT' }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await expect(hook(makeInput(), output)).resolves.toBeUndefined()
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('could not be started')
  })

  it('does not apply its own timeout: a runner that settles late still decides the outcome', async () => {
    const hook = createHook({
      runDetector: () =>
        new Promise<DetectorRunResult>(resolve => {
          setTimeout(() => {
            resolve(ok())
          }, 30)
        }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toBe('ok')
  })
})

describe('extractFeedbackText', () => {
  it('extracts additionalContext from the claude PostToolUse envelope', () => {
    expect(extractFeedbackText(envelope('hello'))).toBe('hello')
  })

  it('tolerates surrounding whitespace around the envelope', () => {
    expect(extractFeedbackText(`  \n${envelope('hello')}\n`)).toBe('hello')
  })

  it('returns null for empty/whitespace input', () => {
    expect(extractFeedbackText('')).toBeNull()
    expect(extractFeedbackText('   \n\t')).toBeNull()
  })

  it('returns null for non-JSON plain text', () => {
    expect(extractFeedbackText('  found: hardcoded hex color  \n')).toBeNull()
  })

  it('returns null for a bare JSON string', () => {
    expect(extractFeedbackText('"x"')).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    expect(extractFeedbackText('[1,2]')).toBeNull()
    expect(extractFeedbackText('null')).toBeNull()
  })

  it('returns null when JSON has no recognized context field', () => {
    expect(extractFeedbackText(JSON.stringify({ foo: 'bar' }))).toBeNull()
  })

  it('returns null for a top-level additionalContext outside hookSpecificOutput', () => {
    expect(extractFeedbackText(JSON.stringify({ additionalContext: 'hi' }))).toBeNull()
  })

  it('returns null for a snake_case additional_context', () => {
    expect(extractFeedbackText(JSON.stringify({ additional_context: 'fix me' }))).toBeNull()
  })

  it('returns null for a wrong hookEventName', () => {
    expect(extractFeedbackText(envelope('hello', 'PreToolUse'))).toBeNull()
  })

  it('returns null for an empty or non-string additionalContext', () => {
    expect(extractFeedbackText(envelope(''))).toBeNull()
    expect(
      extractFeedbackText(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 42 } }),
      ),
    ).toBeNull()
  })
})

describe('surface', () => {
  it('appends only the inner additionalContext text (not raw JSON) when the runner returns findings', async () => {
    const hook = createHook({
      runDetector: fakeRunner(ok(envelope('found: gradient-text at L3'))),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('found: gradient-text at L3')
    expect(output.output).toContain('<impeccable_feedback>')
    expect(output.output).not.toContain('hookSpecificOutput')
  })

  it('appends findings on every call, since findings are not warnings', async () => {
    const hook = createHook({
      runDetector: fakeRunner(ok(envelope('found: gradient-text at L3'))),
      worktree: '/repo',
    })
    const first = makeOutput()
    const second = makeOutput()
    await hook(makeInput(), first)
    await hook(makeInput(), second)
    expect(first.output).toContain('found: gradient-text at L3')
    expect(second.output).toContain('found: gradient-text at L3')
  })

  it('leaves output.output byte-unchanged for a clean scan: exit 0, empty stdout, empty stderr', async () => {
    const hook = createHook({ runDetector: fakeRunner(ok()), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toBe('ok')
  })

  it('leaves output.output byte-unchanged when stdout and stderr are whitespace-only', async () => {
    const hook = createHook({ runDetector: fakeRunner(ok('   \n', ' \n')), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toBe('ok')
  })
})

describe('fail-loud', () => {
  it('warns on a nonzero exit, with a generic message and never the stderr text', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ kind: 'nonzero-exit', exitCode: 1, stdout: 'RAW-STDOUT', stderr: 'RAW-STDERR secret' }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('did not run cleanly')
    expect(output.output).not.toContain('RAW-STDERR')
    expect(output.output).not.toContain('RAW-STDOUT')
  })

  it('warns stderr-on-clean for exit 0 with empty stdout and non-empty stderr, without the stderr text', async () => {
    const hook = createHook({ runDetector: fakeRunner(ok('', 'RAW-STDERR secret')), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('diagnostic output')
    expect(output.output).not.toContain('RAW-STDERR')
  })

  it('warns malformed for non-empty stdout that is not a PostToolUse envelope, without the raw text', async () => {
    const hook = createHook({ runDetector: fakeRunner(ok('RAW-STDOUT not json')), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('unrecognized output')
    expect(output.output).not.toContain('RAW-STDOUT')
  })

  it('does not append stderr text next to a valid envelope', async () => {
    const hook = createHook({ runDetector: fakeRunner(ok(envelope('real finding'), 'RAW-STDERR')), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('real finding')
    expect(output.output).not.toContain('RAW-STDERR')
  })

  it('warns overflow, without any partial output, when the runner reports an overflow', async () => {
    const partial = envelope('PARTIAL-FINDING').slice(0, 40)
    const hook = createHook({
      runDetector: fakeRunner({ kind: 'overflow', stdout: partial, stderr: 'RAW-STDERR' }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('more output than')
    expect(output.output).not.toContain('PARTIAL-FINDING')
    expect(output.output).not.toContain(partial)
    expect(output.output).not.toContain('RAW-STDERR')
  })

  it('warns once (does not throw) when the runner throws', async () => {
    const hook = createHook({
      runDetector: fakeRunner(new Error('boom')),
      worktree: '/repo',
    })
    const output = makeOutput()
    await expect(hook(makeInput(), output)).resolves.toBeUndefined()
    expect(output.output).toContain('[impeccable]')
  })

  it('does not re-warn on a second failure of the same kind (same hook instance)', async () => {
    const hook = createHook({
      runDetector: fakeRunner(new Error('boom')),
      worktree: '/repo',
    })
    const output1 = makeOutput()
    await hook(makeInput(), output1)
    expect(output1.output).toContain('[impeccable]')

    const output2 = makeOutput()
    await hook(makeInput(), output2)
    expect(output2.output).toBe('ok')
  })

  it('shares one malformed kind across bad JSON, a wrong event name and an empty additionalContext', async () => {
    const outputs: string[] = []
    const stdouts = ['{not json', envelope('hello', 'PreToolUse'), envelope('')]
    let call = 0
    const hook = createHook({
      runDetector: async () => ok(stdouts[call++] ?? ''),
      worktree: '/repo',
    })
    for (let i = 0; i < stdouts.length; i++) {
      const output = makeOutput()
      await hook(makeInput(), output)
      outputs.push(output.output)
    }
    expect(outputs[0]).toContain('unrecognized output')
    expect(outputs[1]).toBe('ok')
    expect(outputs[2]).toBe('ok')
  })

  it('warns once per kind: a timeout after an earlier malformed warning still warns, a second timeout does not', async () => {
    const results: DetectorRunResult[] = [
      ok('not json'),
      { kind: 'timeout', stdout: '', stderr: '' },
      { kind: 'timeout', stdout: '', stderr: '' },
    ]
    let call = 0
    const hook = createHook({
      runDetector: async () => results[call++] ?? ok(),
      worktree: '/repo',
    })
    const malformed = makeOutput()
    const timeout1 = makeOutput()
    const timeout2 = makeOutput()
    await hook(makeInput(), malformed)
    await hook(makeInput(), timeout1)
    await hook(makeInput(), timeout2)
    expect(malformed.output).toContain('unrecognized output')
    expect(timeout1.output).toContain('timed out')
    expect(timeout2.output).toBe('ok')
  })

  it('warns once for each of the six kinds on separate instances, and a second occurrence stays silent', async () => {
    const cases: [DetectorRunResult, string][] = [
      [{ kind: 'timeout', stdout: '', stderr: '' }, 'timed out'],
      [{ kind: 'spawn-error', message: 'x' }, 'could not be started'],
      [{ kind: 'nonzero-exit', exitCode: 2, stdout: '', stderr: '' }, 'did not run cleanly'],
      [{ kind: 'overflow', stdout: '', stderr: '' }, 'more output than'],
      [ok('', 'diag'), 'diagnostic output'],
      [ok('nope'), 'unrecognized output'],
    ]
    for (const [result, expected] of cases) {
      const hook = createHook({ runDetector: fakeRunner(result), worktree: '/repo' })
      const first = makeOutput()
      const second = makeOutput()
      await hook(makeInput(), first)
      await hook(makeInput(), second)
      expect(first.output).toContain(expected)
      expect(second.output).toBe('ok')
    }
  })

  it('keeps the kinds independent: every kind warns on a single instance', async () => {
    const results: DetectorRunResult[] = [
      { kind: 'timeout', stdout: '', stderr: '' },
      { kind: 'spawn-error', message: 'x' },
      { kind: 'nonzero-exit', exitCode: 2, stdout: '', stderr: '' },
      { kind: 'overflow', stdout: '', stderr: '' },
      ok('', 'diag'),
      ok('nope'),
    ]
    let call = 0
    const hook = createHook({ runDetector: async () => results[call++] ?? ok(), worktree: '/repo' })
    for (let i = 0; i < results.length; i++) {
      const output = makeOutput()
      await hook(makeInput(), output)
      expect(output.output).toContain('[impeccable]')
    }
  })

  it('leaves a non-string output.output untouched, for a warning and for findings', async () => {
    const warningHook = createHook({
      runDetector: fakeRunner({ kind: 'timeout', stdout: '', stderr: '' }),
      worktree: '/repo',
    })
    const findingHook = createHook({ runDetector: fakeRunner(ok(envelope('found'))), worktree: '/repo' })
    for (const value of [undefined, null, 42, { text: 'x' }, ['a']]) {
      const warnOutput = { title: 't', output: value, metadata: {} } as unknown as ReturnType<typeof makeOutput>
      const findOutput = { title: 't', output: value, metadata: {} } as unknown as ReturnType<typeof makeOutput>
      await expect(warningHook(makeInput(), warnOutput)).resolves.toBeUndefined()
      await expect(findingHook(makeInput(), findOutput)).resolves.toBeUndefined()
      expect(warnOutput.output).toBe(value)
      expect(findOutput.output).toBe(value)
    }
  })

  it('does not spend a kind on a non-string output: the warning still shows on a later string output', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ kind: 'timeout', stdout: '', stderr: '' }),
      worktree: '/repo',
    })
    const skipped = { title: 't', output: 42, metadata: {} } as unknown as ReturnType<typeof makeOutput>
    await hook(makeInput(), skipped)
    const later = makeOutput()
    await hook(makeInput(), later)
    expect(later.output).toContain('timed out')
  })
})
