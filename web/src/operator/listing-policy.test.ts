import {afterEach, describe, expect, it, vi} from 'vitest'
import {fetchRunIndex, initOperatorRunIndex, refreshOperatorRunIndex, resetRunIndexState} from '../../../public/operator-run-index.js'

const policy = () => new Response(JSON.stringify({error: 'redaction-policy-unavailable'}), {status: 503})
const ok = (body: unknown) => new Response(JSON.stringify(body), {status: 200})
const streamSpecifier = '/static/operator-stream.js?manual=1'
let launch: typeof import('../../../public/operator-launch.js') | undefined

afterEach(() => {
  launch?.resetLaunchState()
  launch = undefined
  vi.doUnmock(streamSpecifier)
  resetRunIndexState()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('listing policy unavailability', () => {
  it('only treats the exact policy response as policy unavailable', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(policy()).mockResolvedValueOnce(new Response('{}', {status: 503}))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchRunIndex()).toEqual({kind: 'policy-unavailable'})
    expect(await fetchRunIndex()).toEqual({kind: 'unavailable', authFailure: false})
  })

  it('removes stale run rows on policy failure and restores the first successful listing', async () => {
    document.body.innerHTML = '<section data-role="run-index"><div data-role="run-index-loading"></div><div data-role="run-index-list"></div><div data-role="run-index-empty" hidden></div><div data-role="run-index-unavailable" hidden></div></section>'
    const run = {runId: 'run-one', repo: 'owner/repo', status: 'running', createdAt: '2026-06-26T12:00:00.000Z'}
    const fetch = vi.fn().mockResolvedValueOnce(ok({runs: [run]})).mockResolvedValueOnce(policy()).mockResolvedValueOnce(ok({runs: [run]}))
    vi.stubGlobal('fetch', fetch)
    expect(await initOperatorRunIndex()).toBe('loaded')
    expect(document.querySelector('[data-role="run-index-list"]')?.children.length).toBe(1)
    await refreshOperatorRunIndex()
    expect(document.querySelector('[data-role="run-index-list"]')?.children.length).toBe(0)
    expect(document.querySelector('[data-role="run-index"]')?.getAttribute('data-state')).toBe('policy-unavailable')
    await refreshOperatorRunIndex()
    expect(document.querySelector('[data-role="run-index"]')?.getAttribute('data-state')).toBe('loaded')
    expect(document.querySelector('[data-role="run-index-list"]')?.children.length).toBe(1)
  })

  it('keeps rows on a generic failure, then shows empty only after a successful empty response', async () => {
    document.body.innerHTML = '<section data-role="run-index"><div data-role="run-index-loading"></div><div data-role="run-index-list"></div><div data-role="run-index-empty" hidden></div><div data-role="run-index-unavailable" hidden></div></section>'
    const run = {runId: 'run-one', repo: 'owner/repo', status: 'running', createdAt: '2026-06-26T12:00:00.000Z'}
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({runs: [run]})).mockResolvedValueOnce(new Response('{}', {status: 500})).mockResolvedValueOnce(policy()).mockResolvedValueOnce(ok({runs: []})))
    await initOperatorRunIndex()
    await refreshOperatorRunIndex()
    expect(document.querySelector('[data-role="run-index-list"]')?.children.length).toBe(1)
    await refreshOperatorRunIndex()
    expect(document.querySelector('[data-role="run-index"]')?.getAttribute('data-state')).toBe('policy-unavailable')
    await refreshOperatorRunIndex()
    expect(document.querySelector('[data-role="run-index"]')?.getAttribute('data-state')).toBe('empty')
  })

  it('disables launch during policy outage and automatically restores the picker', async () => {
    vi.doMock(streamSpecifier, () => ({initOperatorStream: vi.fn()}))
    launch = await import('../../../public/operator-launch.js')
    document.body.innerHTML = '<div id="repo-picker-container" data-policy-headline="Operator policy unavailable" data-policy-detail="Listings are hidden"></div><form id="launch-form"><textarea name="prompt"></textarea><button type="submit">Launch</button></form>'
    const fetch = vi.fn().mockResolvedValueOnce(policy()).mockResolvedValueOnce(ok([{owner: 'owner', repo: 'repo'}]))
    vi.stubGlobal('fetch', fetch)
    vi.useFakeTimers()
    await launch.initOperatorLaunch()
    expect(document.querySelector('[data-failure="policy-unavailable"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('#launch-form button')?.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(document.querySelector('#launch-repo-select')?.textContent).toContain('owner/repo')
    expect(document.querySelector<HTMLButtonElement>('#launch-form button')?.disabled).toBe(false)
  })

  it('retries a generic repository failure and shows the real empty state on success', async () => {
    vi.doMock(streamSpecifier, () => ({initOperatorStream: vi.fn()}))
    launch = await import('../../../public/operator-launch.js')
    document.body.innerHTML = '<div id="repo-picker-container"></div><form id="launch-form"><textarea name="prompt"></textarea><button type="submit">Launch</button></form>'
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', {status: 503})).mockResolvedValueOnce(ok([]))
    vi.stubGlobal('fetch', fetch)
    await launch.initOperatorLaunch()
    const retry = document.querySelector<HTMLButtonElement>('[data-failure="unavailable"] button')
    expect(retry?.textContent).toBe('Try again')
    retry?.click()
    await vi.waitFor(() => expect(document.querySelector('#repo-picker-container')?.textContent).toBe('No repositories configured.'))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a policy failure when requested', async () => {
    vi.doMock(streamSpecifier, () => ({initOperatorStream: vi.fn()}))
    launch = await import('../../../public/operator-launch.js')
    document.body.innerHTML = '<div id="repo-picker-container" data-policy-headline="Operator policy unavailable"></div><form id="launch-form"><textarea name="prompt"></textarea><button type="submit">Launch</button></form>'
    const fetch = vi.fn().mockResolvedValueOnce(policy()).mockResolvedValueOnce(ok([{owner: 'owner', repo: 'repo'}]))
    vi.stubGlobal('fetch', fetch)
    await launch.initOperatorLaunch()
    document.querySelector<HTMLButtonElement>('[data-failure="policy-unavailable"] button')?.click()
    await vi.waitFor(() => expect(document.querySelector('#launch-repo-select')).not.toBeNull())
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
