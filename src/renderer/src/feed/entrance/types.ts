import type { Virtualizer } from '@tanstack/react-virtual'
import type { Note } from '../../../../shared/types'

/** The three selectable feed-entrance animations. */
export type FeedEntrance = 'glide' | 'flip' | 'pbd'

/**
 * What the Feed dispatcher passes a strategy runner. The dispatcher owns the suppression
 * STATE; it hands runners the SETTERS they need, so a runner never reaches into Feed internals.
 * @see docs/specs/v0.2.2-repulsion-wave.md §Architecture
 */
export interface EntranceCtx {
  // biome-ignore lint/suspicious/noExplicitAny: virtualizer is generic over the scroll element; runners use only index-agnostic APIs.
  virtualizer: Virtualizer<any, any>
  scrollerEl: HTMLElement | null
  notes: Note[]
  /** Glide family (today's useAppendReveal args). */
  revealingRef: { current: boolean }
  setRevealing: (v: boolean) => void
  suppressThumbResizeRef: { current: boolean }
  /** Wave family — extends follow-suppression from append through spring retire. */
  setWaveSettling: (v: boolean) => void
}
