import {afterEach, expect, it, vi} from 'vitest'
import {initOperatorRunIndex, markRunStreamAttached, refreshOperatorRunIndex, resetRunIndexState} from '../../../public/operator-run-index.js'

afterEach(() => {
  resetRunIndexState()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it.each([
  ['refresh', 'active-stream'],
  ['refresh', 'pending-launch'],
  ['init', 'active-stream'],
  ['init', 'pending-launch'],
] as const)('retains the %s policy outage’s %s card while removing index rows', async (path, cardKind) => {
  document.body.innerHTML = '<section data-role="run-index"><div data-role="run-index-loading"></div><div data-role="run-index-list"></div><div data-role="run-index-empty" hidden></div><div data-role="run-index-unavailable" hidden></div></section>'
  vi.stubGlobal('CSS', {escape: (id: string) => id})
  const run = (runId: string) => ({runId, repo: 'owner/repo', status: 'running', createdAt: '2026-06-26T12:00:00.000Z'})
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({runs: [run('live'), run('stale')]}), {status: 200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({error: 'redaction-policy-unavailable'}), {status: 503})))
  const onListApplied = vi.fn()
  expect(await initOperatorRunIndex({onListApplied})).toBe('loaded')
  const list = document.querySelector<HTMLElement>('[data-role="run-index-list"]')!
  let protectedCard: HTMLElement
  if (cardKind === 'active-stream') {
    protectedCard = list.querySelector<HTMLElement>('[data-run-id="live"]')!
    markRunStreamAttached('live')
  } else {
    protectedCard = document.createElement('div')
    protectedCard.dataset.runId = 'pending'
    protectedCard.dataset.optimistic = 'true'
    protectedCard.innerHTML = '<span data-role="run-status" class="status-pending">Pending</span>'
    list.prepend(protectedCard)
  }
  onListApplied.mockClear()
  if (path === 'refresh') await refreshOperatorRunIndex()
  else expect(await initOperatorRunIndex({onListApplied})).toBe('policy-unavailable')

  expect(Array.from(list.children)).toEqual([protectedCard])
  expect(list.hidden).toBe(false)
  expect(document.querySelector('[data-role="run-index"]')?.getAttribute('data-state')).toBe('policy-unavailable')
  expect(document.querySelector<HTMLElement>('[data-role="run-index-empty"]')?.hidden).toBe(true)
  expect(document.querySelector<HTMLElement>('[data-role="run-index-unavailable"]')?.hidden).toBe(false)
  expect(onListApplied).toHaveBeenCalledExactlyOnceWith([])
})
