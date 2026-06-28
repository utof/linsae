import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Note } from '../../../shared/types'
import { BacklinksContext } from './BacklinksContext'
import { BacklinksPaneBody } from './BacklinksPaneBody'

const note = (id: string, body: string): Note => ({ id, body }) as Note // minimal — only id/body are read

describe('BacklinksPaneBody', () => {
  it('lists backlinks for the focused note from context', async () => {
    const api = installMockApi()
    api.links.backlinks.mockResolvedValue([note('n1', 'links here')])
    renderWithProviders(
      <BacklinksContext.Provider value={{ focusedId: 'target', onJump: () => {} }}>
        <BacklinksPaneBody />
      </BacklinksContext.Provider>,
    )
    expect(await screen.findByText('links here')).toBeInTheDocument()
    expect(api.links.backlinks).toHaveBeenCalledWith({ noteId: 'target' })
  })
  it('shows the empty-state copy when there are no backlinks', async () => {
    const api = installMockApi()
    api.links.backlinks.mockResolvedValue([])
    renderWithProviders(
      <BacklinksContext.Provider value={{ focusedId: 'target', onJump: () => {} }}>
        <BacklinksPaneBody />
      </BacklinksContext.Provider>,
    )
    expect(await screen.findByText('nothing links here yet.')).toBeInTheDocument()
  })
})
