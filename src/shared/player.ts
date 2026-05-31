/**
 * Playback contract for the pinned video player. One implementation at v0.2
 * (YouTube via youtube-player). NOT a speculative abstraction — the boundary is
 * forced by `source_kind` already in the schema; a future `LocalPlayer` is purely
 * additive (ADR 0012). Methods are async (the YouTube impl is Promise-wrapped).
 * @see docs/specs/v0.2-youtube-annotation.md §Player subsystem
 */
export type PlayerState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued'

export interface Player {
  load(videoId: string): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  /** Hard seek (allowSeekAhead = true). */
  seekTo(seconds: number): Promise<void>
  getCurrentTime(): Promise<number>
  /** null until the player has reported a duration (oEmbed has none). */
  getDuration(): Promise<number | null>
  setPlaybackRate(rate: number): Promise<void>
  /** Subscribe to state changes; returns an unsubscribe fn. */
  onStateChange(cb: (s: PlayerState) => void): () => void
  destroy(): void
}
