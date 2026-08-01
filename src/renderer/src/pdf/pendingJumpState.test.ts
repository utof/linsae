// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { PdfLocator } from '../../../shared/types'
import { usePendingJumpStore } from './pendingJumpState'

const locator = (page: number): PdfLocator => ({
  media: 'pdf',
  pdf_id: 'doc-a',
  page,
  rect: [100, 200, 50, 20],
  quote: `q${page}`,
})

describe('pendingJumpState', () => {
  beforeEach(() => {
    // Reset through zustand's own setState rather than consumePendingJump, so a
    // broken consume can't silently mask the next test's starting state.
    usePendingJumpStore.setState({ pending: null })
  })

  it('starts empty', () => {
    expect(usePendingJumpStore.getState().pending).toBeNull()
  })

  it('consuming an empty store returns null', () => {
    expect(usePendingJumpStore.getState().consumePendingJump()).toBeNull()
  })

  it('setPendingJump then consumePendingJump returns the jump', () => {
    const loc = locator(3)
    usePendingJumpStore.getState().setPendingJump('doc-a', loc)
    expect(usePendingJumpStore.getState().consumePendingJump()).toEqual({
      pdfId: 'doc-a',
      locator: loc,
    })
  })

  it('is consumed ONCE: a second consume returns null', () => {
    // Why this matters: the drain in PdfReader re-runs on every render and on every
    // document swap. Without the clear, a read-back jump would re-fire forever.
    usePendingJumpStore.getState().setPendingJump('doc-a', locator(3))
    usePendingJumpStore.getState().consumePendingJump()
    expect(usePendingJumpStore.getState().consumePendingJump()).toBeNull()
  })

  it('clears the stored state in the same call that returns it', () => {
    usePendingJumpStore.getState().setPendingJump('doc-a', locator(3))
    usePendingJumpStore.getState().consumePendingJump()
    expect(usePendingJumpStore.getState().pending).toBeNull()
  })

  it('setting twice overwrites rather than queues — the newest jump wins', () => {
    usePendingJumpStore.getState().setPendingJump('doc-a', locator(3))
    usePendingJumpStore.getState().setPendingJump('doc-b', locator(9))
    expect(usePendingJumpStore.getState().consumePendingJump()).toEqual({
      pdfId: 'doc-b',
      locator: locator(9),
    })
    expect(usePendingJumpStore.getState().consumePendingJump()).toBeNull()
  })
})
