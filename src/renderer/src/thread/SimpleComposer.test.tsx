// @vitest-environment happy-dom
import { fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import { SimpleComposer } from './SimpleComposer'

it('calls onSubmit with the typed body on Enter and clears', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'a reply' } })
  fireEvent.keyDown(ta, { key: 'Enter' }) // Enter sends (ADR 0001)
  expect(onSubmit).toHaveBeenCalledWith('a reply')
  expect((ta as HTMLTextAreaElement).value).toBe('')
})

it('Shift+Enter inserts a newline and does not submit', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: 'line1' } })
  fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
  expect(onSubmit).not.toHaveBeenCalled()
})

it('does not submit on Enter when the body is whitespace-only (trim-empty guard)', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: '   ' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onSubmit).not.toHaveBeenCalled()
})

it('trims surrounding whitespace from the submitted body', () => {
  const onSubmit = vi.fn()
  renderWithProviders(<SimpleComposer onSubmit={onSubmit} />)
  const ta = screen.getByRole('textbox')
  fireEvent.change(ta, { target: { value: '  padded  ' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onSubmit).toHaveBeenCalledWith('padded')
})
