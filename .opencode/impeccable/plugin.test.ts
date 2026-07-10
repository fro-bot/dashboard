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
      runDetector: fakeRunner({ stdout: '', stderr: '', exitCode: 0 }, calls),
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
      runDetector: fakeRunner({ stdout: '', stderr: '', exitCode: 0 }, calls),
      worktree: '/repo',
    })
    await hook(makeInput({ tool: 'read' }), makeOutput())
    expect(calls).toHaveLength(0)
  })

  it('invokes the runner zero times when no path can be extracted', async () => {
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner({ stdout: '', stderr: '', exitCode: 0 }, calls),
      worktree: '/repo',
    })
    await hook(makeInput({ args: {} }), makeOutput())
    expect(calls).toHaveLength(0)
  })

  it('degrades to no-op without throwing when the runner exceeds the timeout', async () => {
    const hook = createHook({
      runDetector: () => new Promise<DetectorRunResult>(() => {}), // never resolves
      worktree: '/repo',
      timeoutMs: 10,
    })
    const output = makeOutput()
    await expect(hook(makeInput(), output)).resolves.toBeUndefined()
    expect(output.output).toBe('ok')
  })
})

describe('extractFeedbackText', () => {
  it('extracts additionalContext from the claude hookSpecificOutput envelope', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hello' },
    })
    expect(extractFeedbackText(stdout)).toBe('hello')
  })

  it('extracts top-level additionalContext', () => {
    expect(extractFeedbackText(JSON.stringify({ additionalContext: 'hi' }))).toBe('hi')
  })

  it('extracts snake_case additional_context', () => {
    expect(extractFeedbackText(JSON.stringify({ additional_context: 'fix me' }))).toBe('fix me')
  })

  it('returns non-JSON plain text verbatim (trimmed)', () => {
    expect(extractFeedbackText('  found: hardcoded hex color  \n')).toBe('found: hardcoded hex color')
  })

  it('returns "" for empty/whitespace input', () => {
    expect(extractFeedbackText('')).toBe('')
    expect(extractFeedbackText('   \n\t')).toBe('')
  })

  it('falls back to raw trimmed stdout for a bare JSON string', () => {
    expect(extractFeedbackText('"x"')).toBe('"x"')
  })

  it('falls back to raw trimmed stdout when JSON has no recognized context field', () => {
    const stdout = JSON.stringify({ foo: 'bar' })
    expect(extractFeedbackText(stdout)).toBe(stdout)
  })
})

describe('surface', () => {
  it('appends only the inner additionalContext text (not raw JSON) when the runner returns findings', async () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'found: gradient-text at L3' },
    })
    const hook = createHook({
      runDetector: fakeRunner({ stdout, stderr: '', exitCode: 0 }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('found: gradient-text at L3')
    expect(output.output).toContain('<impeccable_feedback>')
    expect(output.output).not.toContain('hookSpecificOutput')
  })

  it('leaves output.output byte-unchanged when stdout is empty', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ stdout: '', stderr: '', exitCode: 0 }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toBe('ok')
  })

  it('leaves output.output byte-unchanged when stdout is whitespace-only', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ stdout: '   \n', stderr: '', exitCode: 0 }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toBe('ok')
  })
})

describe('fail-loud', () => {
  it('warns when the detector exits nonzero (hook.mjs is contractually always-exit-0)', async () => {
    const hook = createHook({
      runDetector: fakeRunner({ stdout: '', stderr: 'node: cannot find module', exitCode: 1 }),
      worktree: '/repo',
    })
    const output = makeOutput()
    await hook(makeInput(), output)
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('did not run cleanly')
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

  it('does not re-warn on a second failure in the same session (same hook instance)', async () => {
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
})
