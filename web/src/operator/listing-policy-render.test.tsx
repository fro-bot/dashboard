import {renderToStaticMarkup} from 'react-dom/server'
import {afterEach, expect, it, vi} from 'vitest'
import {initOperatorRunIndex, resetRunIndexState} from '../../../public/operator-run-index.js'
import {Operator} from '../views/Operator.tsx'

afterEach(() => {
  resetRunIndexState()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('renders the policy explanation and retry in the real Recent Runs shell', async () => {
  document.body.innerHTML = renderToStaticMarkup(<Operator state="ready" />)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({error: 'redaction-policy-unavailable'}), {status: 503})))
  await initOperatorRunIndex()
  const failure = document.querySelector<HTMLElement>('[data-role="run-index-unavailable"]')
  expect(failure?.hidden).toBe(false)
  expect(failure?.dataset.failure).toBe('policy-unavailable')
  expect(failure?.querySelector('[data-list-failure="policy-unavailable"]')?.textContent).toContain("gateway can't load its redaction policy")
  expect(failure?.querySelector('button')?.textContent).toBe('Try again')
  expect(document.querySelector<HTMLElement>('[data-role="run-index-empty"]')?.hidden).toBe(true)
})
