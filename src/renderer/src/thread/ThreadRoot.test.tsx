// @vitest-environment happy-dom
import { screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { ThreadRoot } from './ThreadRoot'

const note: Note = {
  id: 'n1',
  slug: 'hello',
  body: 'hello world',
  type: 'claim',
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
}

it('renders the root note body as the thread header', () => {
  renderWithProviders(<ThreadRoot note={note} />)
  expect(screen.getByText('hello world')).toBeInTheDocument()
})
