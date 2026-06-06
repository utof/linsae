// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deriveState } from './player-state'

describe('deriveState', () => {
  it('maps the video flag combos to the PlayerState union', () => {
    expect(
      deriveState({ ready: false, ended: false, paused: true, waiting: false, started: false }),
    ).toBe('unstarted')
    expect(
      deriveState({ ready: true, ended: false, paused: true, waiting: false, started: false }),
    ).toBe('cued')
    expect(
      deriveState({ ready: true, ended: false, paused: false, waiting: true, started: true }),
    ).toBe('buffering')
    expect(
      deriveState({ ready: true, ended: false, paused: false, waiting: false, started: true }),
    ).toBe('playing')
    expect(
      deriveState({ ready: true, ended: false, paused: true, waiting: false, started: true }),
    ).toBe('paused')
    expect(
      deriveState({ ready: true, ended: true, paused: true, waiting: false, started: true }),
    ).toBe('ended')
  })
})
