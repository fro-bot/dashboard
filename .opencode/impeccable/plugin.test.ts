import { describe, expect, it } from 'vitest'

import {
  bareToolName,
  buildChildEnv,
  buildHookPayload,
  createHook,
  extractFeedbackText,
  extractTouchedPaths,
  FEEDBACK_MAX_CHARS,
  isMutatingTool,
  PATH_ARG_KEYS,
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
  it('produces the exact field names the hook reads for a representative edit event', () => {
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

/** Args whose path property throws when read, which fails inside the hook itself rather than in the runner. */
function throwingArgs(): unknown {
  return {
    get filePath(): string {
      throw new Error('RAW-INTERNAL-DETAIL')
    },
  }
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
      runDetector: fakeRunner({ kind: 'spawn-error' }),
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

describe('buildHookPayload rename destinations', () => {
  const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
  const commandOf = (patchText: string, tool = 'apply_patch') => {
    const payload = buildHookPayload({ tool, args: { patchText }, cwd: '/repo', sessionID: 's' })
    return 'command' in payload.tool_input ? payload.tool_input.command : ''
  }

  it('appends an Update marker for the Move-to destination of a rename', () => {
    const patchText = patch('*** Update File: a.tsx', '*** Move to: b.tsx', '@@', '-x', '+y')
    const command = commandOf(patchText)
    expect(command.startsWith(patchText)).toBe(true)
    expect(command).toMatch(/^\*\*\* Update File: b\.tsx$/m)
  })

  it('passes a patch with only Add, Update and Delete markers through unchanged', () => {
    const patchText = patch('*** Add File: a.ts', '+x', '*** Update File: b.ts', '@@', '-1', '+2', '*** Delete File: c.ts')
    expect(commandOf(patchText)).toBe(patchText)
  })

  it('appends one marker per distinct destination and none for a destination already updated', () => {
    const patchText = patch(
      '*** Update File: a.tsx',
      '*** Move to: b.tsx',
      '*** Update File: c.tsx',
      '*** Move to: d.tsx',
      '*** Update File: d.tsx',
      '*** Update File: e.tsx',
      '*** Move to: b.tsx',
    )
    const command = commandOf(patchText)
    expect(command.startsWith(patchText)).toBe(true)
    const appended = command.slice(patchText.length)
    expect(appended).toBe('\n*** Update File: b.tsx')
  })

  it('adds the marker for an MCP-suffixed apply_patch tool too', () => {
    const command = commandOf(patch('*** Update File: a.tsx', '*** Move to: b.tsx'), 'aft_apply_patch')
    expect(command).toMatch(/^\*\*\* Update File: b\.tsx$/m)
  })

  it('leaves edit and write payloads unchanged', () => {
    const payload = buildHookPayload({ tool: 'write', args: { filePath: 'src/App.tsx' }, cwd: '/repo', sessionID: 's' })
    expect(payload.tool_input).toEqual({ file_path: 'src/App.tsx' })
  })
})

describe('no-path warning', () => {
  it('warns no-path once for a built-in edit with no filePath, and does not run the hook', async () => {
    const calls: unknown[][] = []
    const hook = createHook({ runDetector: fakeRunner(ok(), calls), worktree: '/repo' })
    const first = makeOutput()
    const second = makeOutput()
    await hook(makeInput({ args: {} }), first)
    await hook(makeInput({ args: {} }), second)
    expect(calls).toHaveLength(0)
    expect(first.output).toContain('[impeccable]')
    expect(first.output).toContain('no extractable path')
    expect(second.output).toBe('ok')
  })

  it('warns no-path for built-in write and apply_patch with no path', async () => {
    for (const [tool, args] of [
      ['write', {}],
      ['apply_patch', {}],
      ['apply_patch', { patchText: '*** Begin Patch\n*** End Patch' }],
      ['edit', { filePath: '' }],
      ['edit', undefined],
    ] as [string, unknown][]) {
      const hook = createHook({ runDetector: fakeRunner(ok()), worktree: '/repo' })
      const output = makeOutput()
      await hook(makeInput({ tool, args }), output)
      expect(output.output, `${tool} ${JSON.stringify(args)}`).toContain('no extractable path')
    }
  })

  it('warns no-path for an MCP edit/write/apply_patch tool whose args carry a path-like key with no usable value', async () => {
    for (const [tool, args] of [
      ['aft_edit', { filePath: '' }],
      ['x_write', { filePath: 42 }],
      ['aft_apply_patch', { patchText: '' }],
    ] as [string, unknown][]) {
      const calls: unknown[][] = []
      const hook = createHook({ runDetector: fakeRunner(ok(), calls), worktree: '/repo' })
      const output = makeOutput()
      await hook(makeInput({ tool, args }), output)
      expect(calls).toHaveLength(0)
      expect(output.output, `${tool} ${JSON.stringify(args)}`).toContain('no extractable path')
    }
  })

  it('stays silent, without running the hook, for an MCP edit/write tool with no path-like arg', async () => {
    for (const [tool, args] of [
      ['foo_edit', {}],
      ['foo_edit', undefined],
      ['foo_write', { content: 'x' }],
      ['foo_edit', { query: 'x' }],
      ['foo_apply_patch', {}],
    ] as [string, unknown][]) {
      const calls: unknown[][] = []
      const hook = createHook({ runDetector: fakeRunner(ok(), calls), worktree: '/repo' })
      const output = makeOutput()
      await hook(makeInput({ tool, args }), output)
      expect(calls, `${tool} ${JSON.stringify(args)}`).toHaveLength(0)
      expect(output.output).toBe('ok')
    }
  })

  it('stays silent for non-mutating tools whatever their args', async () => {
    const hook = createHook({ runDetector: fakeRunner(ok()), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput({ tool: 'read', args: {} }), output)
    expect(output.output).toBe('ok')
  })

  it('uses its own kind: a no-path warning does not silence a later timeout warning', async () => {
    const results: DetectorRunResult[] = [{ kind: 'timeout', stdout: '', stderr: '' }]
    const hook = createHook({ runDetector: async () => results[0]!, worktree: '/repo' })
    const noPath = makeOutput()
    const timeout = makeOutput()
    await hook(makeInput({ args: {} }), noPath)
    await hook(makeInput(), timeout)
    expect(noPath.output).toContain('no extractable path')
    expect(timeout.output).toContain('timed out')
  })
})

describe('paths reach the hook as given', () => {
  it('passes absolute, relative and out-of-worktree paths through unchanged', async () => {
    for (const filePath of ['/repo/web/src/App.tsx', 'web/src/App.tsx', './web/src/App.tsx', '../other/App.tsx', '/elsewhere/App.tsx']) {
      const calls: unknown[][] = []
      const hook = createHook({ runDetector: fakeRunner(ok(), calls), worktree: '/repo' })
      await hook(makeInput({ args: { filePath } }), makeOutput())
      const [payload] = calls[0] as [ReturnType<typeof buildHookPayload>]
      expect(payload.tool_input).toEqual({ file_path: filePath })
      expect(payload.cwd).toBe('/repo')
    }
  })
})

describe('PATH_ARG_KEYS', () => {
  it('names exactly the arg keys extractTouchedPaths reads', () => {
    const keys = Object.values(PATH_ARG_KEYS)
    expect(keys.toSorted()).toEqual(['filePath', 'patchText'])

    // Each named key yields a path for the tool that reads it.
    expect(extractTouchedPaths('edit', { [PATH_ARG_KEYS.file]: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(extractTouchedPaths('apply_patch', { [PATH_ARG_KEYS.patch]: '*** Add File: a.ts\n' })).toEqual(['a.ts'])

    // A key outside the set yields nothing, for every tool shape.
    for (const tool of ['edit', 'write', 'apply_patch', 'aft_edit', 'aft_apply_patch']) {
      expect(extractTouchedPaths(tool, { path: '/a/b.ts', file_path: '/a/b.ts', patch: '*** Add File: a.ts\n' })).toEqual([])
    }
  })

  it('is the set that makes a namespaced tool expect a path', async () => {
    for (const key of Object.values(PATH_ARG_KEYS)) {
      const hook = createHook({ runDetector: fakeRunner(ok()), worktree: '/repo' })
      const output = makeOutput()
      await hook(makeInput({ tool: 'foo_edit', args: { [key]: '' } }), output)
      expect(output.output, key).toContain('no extractable path')
    }
    const hook = createHook({ runDetector: fakeRunner(ok()), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput({ tool: 'foo_edit', args: { path: '' } }), output)
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

describe('feedback cap', () => {
  const MARKER = '[impeccable] feedback truncated'
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  async function appendedFor(feedback: string): Promise<string> {
    const hook = createHook({ runDetector: fakeRunner(ok(envelope(feedback))), worktree: '/repo' })
    const output = makeOutput()
    await hook(makeInput(), output)
    return output.output
  }

  it('caps feedback at 64 KiB of UTF-16 code units', () => {
    expect(FEEDBACK_MAX_CHARS).toBe(64 * 1024)
  })

  it('appends feedback exactly at the cap unchanged, with no marker', async () => {
    const feedback = 'a'.repeat(FEEDBACK_MAX_CHARS)
    expect(await appendedFor(feedback)).toBe(`ok\n\n<impeccable_feedback>\n${feedback}\n</impeccable_feedback>`)
  })

  it('truncates feedback one code unit over the cap to the cap and adds the marker inside the wrapper', async () => {
    const feedback = 'a'.repeat(FEEDBACK_MAX_CHARS) + 'Z'
    const result = await appendedFor(feedback)
    expect(result).toBe(
      `ok\n\n<impeccable_feedback>\n${'a'.repeat(FEEDBACK_MAX_CHARS)}\n${MARKER}\n</impeccable_feedback>`,
    )
    expect(result).not.toContain('Z')
  })

  it('drops a high surrogate left alone when the cut lands inside a surrogate pair', async () => {
    // The pair occupies indexes CAP-1 and CAP, so the cap would keep only its high half.
    const feedback = `${'a'.repeat(FEEDBACK_MAX_CHARS - 1)}\u{1F600}tail`
    const result = await appendedFor(feedback)
    expect(result).not.toMatch(LONE_SURROGATE)
    expect(result).toBe(
      `ok\n\n<impeccable_feedback>\n${'a'.repeat(FEEDBACK_MAX_CHARS - 1)}\n${MARKER}\n</impeccable_feedback>`,
    )
  })

  it('keeps a whole surrogate pair that ends exactly at the cap', async () => {
    const feedback = `${'a'.repeat(FEEDBACK_MAX_CHARS - 2)}\u{1F600}tail`
    const result = await appendedFor(feedback)
    expect(result).not.toMatch(LONE_SURROGATE)
    expect(result).toContain(`${'a'.repeat(FEEDBACK_MAX_CHARS - 2)}\u{1F600}\n${MARKER}`)
    expect(result).not.toContain('tail')
  })

  it('does not use up a warning kind: a warning after a truncation still appears, and truncation repeats', async () => {
    const results: DetectorRunResult[] = [
      ok(envelope('a'.repeat(FEEDBACK_MAX_CHARS + 10))),
      { kind: 'timeout', stdout: '', stderr: '' },
      ok(envelope('a'.repeat(FEEDBACK_MAX_CHARS + 10))),
      { kind: 'timeout', stdout: '', stderr: '' },
    ]
    let call = 0
    const hook = createHook({ runDetector: async () => results[call++] ?? ok(), worktree: '/repo' })
    const outputs = [makeOutput(), makeOutput(), makeOutput(), makeOutput()]
    for (const output of outputs) await hook(makeInput(), output)

    expect(outputs[0]!.output).toContain(MARKER)
    expect(outputs[0]!.output).not.toContain('timed out')
    expect(outputs[1]!.output).toContain('timed out')
    // The marker is not a warning: it appears on every truncation.
    expect(outputs[2]!.output).toContain(MARKER)
    // The timeout kind was spent once by the earlier timeout.
    expect(outputs[3]!.output).toBe('ok')
  })

  it('does not emit a warning of its own when it truncates', async () => {
    const result = await appendedFor('a'.repeat(FEEDBACK_MAX_CHARS * 2))
    expect(result.match(/\[impeccable\]/g)).toHaveLength(1)
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

  it('warns bridge-error, not spawn-error, with fixed text when the runner throws', async () => {
    const hook = createHook({ runDetector: fakeRunner(new Error('RAW-INTERNAL-DETAIL')), worktree: '/repo' })
    const output = makeOutput()
    await expect(hook(makeInput(), output)).resolves.toBeUndefined()
    expect(output.output).toContain('design hook bridge hit an internal error')
    expect(output.output).not.toContain('could not be started')
    expect(output.output).not.toContain('RAW-INTERNAL-DETAIL')
  })

  it('warns bridge-error, not spawn-error, with fixed text when the hook itself faults', async () => {
    const calls: unknown[][] = []
    const hook = createHook({ runDetector: fakeRunner(ok(), calls), worktree: '/repo' })
    const output = makeOutput()
    await expect(hook(makeInput({ args: throwingArgs() }), output)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(output.output).toContain('design hook bridge hit an internal error')
    expect(output.output).not.toContain('could not be started')
    expect(output.output).not.toContain('RAW-INTERNAL-DETAIL')
  })

  it('keeps bridge-error and spawn-error as separate kinds', async () => {
    const results: (DetectorRunResult | Error)[] = [new Error('boom'), { kind: 'spawn-error' }]
    let call = 0
    const hook = createHook({
      runDetector: async () => {
        const next = results[call++] ?? ok()
        if (next instanceof Error) throw next
        return next
      },
      worktree: '/repo',
    })
    const first = makeOutput()
    const second = makeOutput()
    await hook(makeInput(), first)
    await hook(makeInput(), second)
    expect(first.output).toContain('internal error')
    expect(second.output).toContain('could not be started')
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

  it('warns once for each runner-reported kind on separate instances, and a second occurrence stays silent', async () => {
    const cases: [DetectorRunResult, string][] = [
      [{ kind: 'timeout', stdout: '', stderr: '' }, 'timed out'],
      [{ kind: 'spawn-error' }, 'could not be started'],
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

  it('keeps the kinds independent: all eight kinds warn on a single instance', async () => {
    const results: DetectorRunResult[] = [
      { kind: 'timeout', stdout: '', stderr: '' },
      { kind: 'spawn-error' },
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
    const noPath = makeOutput()
    await hook(makeInput({ args: {} }), noPath)
    expect(noPath.output).toContain('no extractable path')

    const bridgeError = makeOutput()
    await hook(makeInput({ args: throwingArgs() }), bridgeError)
    expect(bridgeError.output).toContain('internal error')
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

describe('engine warm-up (createHook)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(res => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('skips the scan and warns engine-pending once while the warm-up is pending, then scans once it resolves', async () => {
    const warm = deferred<boolean>()
    let warmCalls = 0
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(envelope('found: gradient-text')), calls),
      worktree: '/repo',
      warmEngine: () => {
        warmCalls += 1
        return warm.promise
      },
      engineReadyWaitMs: 10,
    })

    const first = makeOutput()
    await expect(hook(makeInput(), first)).resolves.toBeUndefined()
    expect(first.output).toContain('[impeccable] design engine is still downloading')
    expect(calls).toHaveLength(0)

    const second = makeOutput()
    await hook(makeInput(), second)
    expect(second.output).toBe('ok')
    expect(calls).toHaveLength(0)

    warm.resolve(true)
    const third = makeOutput()
    await hook(makeInput(), third)
    expect(calls).toHaveLength(1)
    expect(third.output).toContain('found: gradient-text')
    expect(warmCalls).toBe(1)
  })

  it('does not stop the warm-up when a hook call stops waiting for it', async () => {
    const warm = deferred<boolean>()
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(), calls),
      worktree: '/repo',
      warmEngine: () => warm.promise,
      engineReadyWaitMs: 5,
    })
    await hook(makeInput(), makeOutput())
    await hook(makeInput(), makeOutput())
    warm.resolve(true)
    await hook(makeInput(), makeOutput())
    expect(calls).toHaveLength(1)
  })

  it('warns engine-unavailable once and skips when the warm-up fails, then retries after the retry interval', async () => {
    let clock = 1_000
    let attempts = 0
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(envelope('found')), calls),
      worktree: '/repo',
      warmEngine: () => {
        attempts += 1
        return Promise.resolve(attempts >= 2)
      },
      now: () => clock,
      engineRetryMs: 60_000,
    })

    const first = makeOutput()
    await hook(makeInput(), first)
    expect(first.output).toContain('[impeccable] design engine could not be fetched or started')
    expect(calls).toHaveLength(0)
    expect(attempts).toBe(1)

    clock += 30_000
    const early = makeOutput()
    await hook(makeInput(), early)
    expect(early.output).toBe('ok')
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(0)

    clock += 31_000
    const retried = makeOutput()
    await hook(makeInput(), retried)
    expect(attempts).toBe(2)
    expect(calls).toHaveLength(1)
    expect(retried.output).toContain('found')
  })

  it('treats a warm-up that throws or rejects as a failed warm-up and never throws', async () => {
    for (const warmEngine of [
      () => Promise.reject(new Error('boom')),
      () => {
        throw new Error('boom')
      },
    ]) {
      const calls: unknown[][] = []
      const hook = createHook({ runDetector: fakeRunner(ok(), calls), worktree: '/repo', warmEngine })
      const output = makeOutput()
      await expect(hook(makeInput(), output)).resolves.toBeUndefined()
      expect(output.output).toContain('could not be fetched or started')
      expect(calls).toHaveLength(0)
    }
  })

  it('adds no warning and scans on the first call when the warm-up resolves at once', async () => {
    let warmCalls = 0
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(), calls),
      worktree: '/repo',
      warmEngine: () => {
        warmCalls += 1
        return Promise.resolve(true)
      },
    })
    const first = makeOutput()
    await hook(makeInput(), first)
    await hook(makeInput(), makeOutput())

    expect(first.output).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(warmCalls).toBe(1)
  })

  it('runs one warm-up across concurrent calls', async () => {
    const warm = deferred<boolean>()
    let warmCalls = 0
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(), calls),
      worktree: '/repo',
      warmEngine: () => {
        warmCalls += 1
        return warm.promise
      },
    })

    const pending = Array.from({ length: 5 }, () => hook(makeInput(), makeOutput()))
    setTimeout(() => {
      warm.resolve(true)
    }, 20)
    await Promise.all(pending)

    expect(warmCalls).toBe(1)
    expect(calls).toHaveLength(5)
  })

  it('does not wait for the warm-up on a call that needs no scan', async () => {
    let warmCalls = 0
    const hook = createHook({
      runDetector: fakeRunner(ok()),
      worktree: '/repo',
      warmEngine: () => {
        warmCalls += 1
        return new Promise<boolean>(() => {})
      },
    })
    await hook(makeInput({ tool: 'read' }), makeOutput())
    await hook(makeInput({ args: {} }), makeOutput())
    expect(warmCalls).toBe(0)
  })
})

describe('fast skip while the warm-up is pending (createHook)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(res => {
      resolve = res
    })
    return { promise, resolve }
  }

  async function timed(run: () => Promise<void>): Promise<number> {
    const start = performance.now()
    await run()
    return performance.now() - start
  }

  it('skips at once, without waiting or spawning, on every call after one has seen the warm-up pending', async () => {
    const warm = deferred<boolean>()
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(envelope('found')), calls),
      worktree: '/repo',
      warmEngine: () => warm.promise,
      engineReadyWaitMs: 300,
    })

    const first = makeOutput()
    const firstMs = await timed(() => hook(makeInput(), first))
    expect(firstMs).toBeGreaterThanOrEqual(250)
    expect(first.output).toContain('still downloading')

    for (let i = 0; i < 2; i += 1) {
      const output = makeOutput()
      const elapsedMs = await timed(() => hook(makeInput(), output))
      expect(elapsedMs).toBeLessThan(50)
      expect(output.output).toBe('ok')
    }
    expect(calls).toHaveLength(0)

    warm.resolve(true)
    const after = makeOutput()
    await hook(makeInput(), after)
    expect(calls).toHaveLength(1)
    expect(after.output).toContain('found')
  })

  it('applies the engine-unavailable and retry logic when a warm-up that was seen pending then fails', async () => {
    let clock = 1_000
    let attempts = 0
    const first = deferred<boolean>()
    const calls: unknown[][] = []
    const hook = createHook({
      runDetector: fakeRunner(ok(envelope('found')), calls),
      worktree: '/repo',
      warmEngine: () => {
        attempts += 1
        return attempts === 1 ? first.promise : Promise.resolve(true)
      },
      engineReadyWaitMs: 10,
      engineRetryMs: 60_000,
      now: () => clock,
    })

    await hook(makeInput(), makeOutput())
    first.resolve(false)

    const failed = makeOutput()
    await hook(makeInput(), failed)
    expect(failed.output).toContain('could not be fetched or started')
    expect(calls).toHaveLength(0)

    clock += 61_000
    const retried = makeOutput()
    await hook(makeInput(), retried)
    expect(attempts).toBe(2)
    expect(calls).toHaveLength(1)
  })

  it('waits for a retried warm-up again before it is seen pending', async () => {
    let clock = 1_000
    let attempts = 0
    const second = deferred<boolean>()
    const hook = createHook({
      runDetector: fakeRunner(ok()),
      worktree: '/repo',
      warmEngine: () => {
        attempts += 1
        return attempts === 1 ? Promise.resolve(false) : second.promise
      },
      engineReadyWaitMs: 150,
      engineRetryMs: 60_000,
      now: () => clock,
    })

    await hook(makeInput(), makeOutput())
    clock += 61_000
    const elapsedMs = await timed(() => hook(makeInput(), makeOutput()))
    expect(attempts).toBe(2)
    expect(elapsedMs).toBeGreaterThanOrEqual(100)
  })
})

describe('buildChildEnv', () => {
  it('keeps only the allow-listed names, every IMPECCABLE_ variable but the depth one, and the bridge signals', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      USER: 'u',
      LOGNAME: 'u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      IMPECCABLE_HOME: '/cache',
      IMPECCABLE_DOWNLOAD_BASE: 'http://x',
      IMPECCABLE_HOOK_DEPTH: '1',
      CLAUDE_HOOK_DEPTH: '1',
      IMPECCABLE_HOOK_HARNESS: 'cursor',
      IMPECCABLE_HOOK_QUIET: '0',
      GITHUB_TOKEN: 'ghp_secret',
      FAKE_SECRET: 'secret',
      NODE_OPTIONS: '--inspect',
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      USER: 'u',
      LOGNAME: 'u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      IMPECCABLE_HOME: '/cache',
      IMPECCABLE_DOWNLOAD_BASE: 'http://x',
      IMPECCABLE_HOOK_HARNESS: 'claude',
      IMPECCABLE_HOOK_QUIET: '1',
    })
  })

  it('forwards the proxy and CA variables by exact name, in upper and lower case, and nothing that merely resembles them', () => {
    const forwarded = {
      HTTP_PROXY: 'http://user:pass@proxy:3128',
      HTTPS_PROXY: 'http://user:pass@proxy:3128',
      NO_PROXY: 'localhost',
      ALL_PROXY: 'socks5://proxy:1080',
      http_proxy: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      no_proxy: 'localhost',
      all_proxy: 'socks5://proxy:1080',
      SSL_CERT_FILE: '/etc/ssl/ca.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      CURL_CA_BUNDLE: '/etc/ssl/ca.pem',
    }
    const env = buildChildEnv({
      ...forwarded,
      HTTPS_PROXY_USER: 'u',
      Https_Proxy: 'http://mixed-case',
      SSL_CERT_FILE_BACKUP: '/x',
      CURL_HOME: '/home/u',
      PROXY: 'http://proxy',
      GITHUB_TOKEN: 'ghp_secret',
    })

    expect(env).toEqual({ ...forwarded, IMPECCABLE_HOOK_HARNESS: 'claude', IMPECCABLE_HOOK_QUIET: '1' })
  })

  it('omits allow-listed names the source does not set', () => {
    expect(buildChildEnv({})).toEqual({ IMPECCABLE_HOOK_HARNESS: 'claude', IMPECCABLE_HOOK_QUIET: '1' })
  })
})
