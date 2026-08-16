// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App'

class ResizeObserverStub implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

globalThis.ResizeObserver = ResizeObserverStub

afterEach(() => {
  document.body.replaceChildren()
})

describe('application shell', () => {
  it('renders the React Flow work canvas', () => {
    const { container } = render(<App />)

    expect(screen.getByRole('main', { name: 'GADE work canvas' })).toBeTruthy()
    expect(container.querySelector('.react-flow')).not.toBeNull()
  })
})
