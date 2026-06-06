import type { PlayerState } from '../../../shared/player'
export interface VideoFlags {
  ready: boolean
  ended: boolean
  paused: boolean
  waiting: boolean
  started: boolean
}
/** Mirrors the legacy YT-code mapping (spec §6). Order matters. */
export function deriveState(f: VideoFlags): PlayerState {
  if (f.ended) return 'ended'
  if (f.waiting && f.started) return 'buffering'
  if (!f.paused && f.started) return 'playing'
  if (f.started) return 'paused'
  if (f.ready) return 'cued'
  return 'unstarted'
}
