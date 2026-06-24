import {render, screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import App from './App.tsx'

describe('App', () => {
  it('renders the root heading', () => {
    render(<App />)
    expect(screen.getByRole('heading', {level: 1})).toHaveTextContent('Fro Bot Dashboard')
  })

  it('mounts without throwing', () => {
    expect(() => render(<App />)).not.toThrow()
  })
})
