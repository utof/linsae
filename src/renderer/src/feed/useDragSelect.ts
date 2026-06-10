// src/renderer/src/feed/useDragSelect.ts
import type { Virtualizer } from '@tanstack/react-virtual'
import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback } from 'react'
import type { Note } from '../../../shared/types'
import { indicesInRange } from './selectionRange'

/** Vertical movement (px) before a gutter press becomes a selection drag —
 * below it, the press is treated as a plain (no-op) background click. */
const DRAG_THRESHOLD_PX = 5
/** Pointer-proximity band (px) at the scroller's top/bottom edge that
 * triggers auto-scroll while dragging, so a drag can select past the fold. */
const EDGE_ZONE_PX = 32
/** Auto-scroll speed cap (px/frame ≈ px/16ms) — fast enough to traverse,
 * slow enough that the live range stays readable. */
const EDGE_SCROLL_MAX = 16

interface Args {
  scrollerEl: HTMLDivElement | null
  contentRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  notes: Note[]
  /** Live mirror of the Feed's selectedIds — read once at drag start as the
   * rubber-band base, so pre-existing selection survives the drag. */
  selectedIdsRef: RefObject<ReadonlySet<string>>
  setSelectedIds: (next: ReadonlySet<string>) => void
}

/**
 * Telegram-style gutter drag-select for the feed: press in empty row space
 * (not on a bubble/card/control), drag vertically, and rows whose spans the
 * drag range crosses are selected live — `base ∪ rows-in-range`, recomputed
 * from the drag-start base each move so shrinking the range deselects.
 *
 * Anchor is captured in CONTENT coordinates (`clientY - content rect top`)
 * so it stays pinned to the same note while the scroller auto-scrolls under
 * the pointer; the content element moves with scroll, the anchor doesn't.
 *
 * Why window pointermove/pointerup listeners (not setPointerCapture): the
 * established repo pattern — `useScrollThumb.onThumbPointerDown` does the
 * same — and it behaves identically in happy-dom tests.
 *
 * Why hit-testing `getVirtualItems()` (rendered window only, overscan 8):
 * during a drag the range edge is at the pointer, which is by definition
 * inside the viewport; rows scrolled past mid-drag were selected while they
 * were rendered, and the base∪range recompute never removes them unless the
 * range shrinks past them while they are rendered again. Off-screen misses
 * are only possible via edge auto-scroll faster than selection recompute —
 * the recompute runs every scroll tick, so the window can't outrun it.
 *
 * @see docs/plans/v0.2.3-multi-select.md
 */
export function useDragSelect({
  scrollerEl,
  contentRef,
  virtualizer,
  notes,
  selectedIdsRef,
  setSelectedIds,
}: Args): { onGutterPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void } {
  const onGutterPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const content = contentRef.current
      if (!scrollerEl || !content) return
      // Presses on interactive surfaces are theirs: bubbles select text /
      // focus, buttons act, the media card opens. Only true gutter presses
      // (row wrapper background, day dividers, scroller background) start a
      // selection drag.
      const target = e.target as HTMLElement
      if (target.closest('[data-bubble], button, a, textarea, input')) return

      const startClientY = e.clientY
      const anchorY = startClientY - content.getBoundingClientRect().top
      const base: ReadonlySet<string> = selectedIdsRef.current ?? new Set<string>()
      let active = false
      let lastClientY = startClientY
      let raf = 0

      const applyRange = () => {
        const curY = lastClientY - content.getBoundingClientRect().top
        const next = new Set(base)
        for (const i of indicesInRange(virtualizer.getVirtualItems(), anchorY, curY)) {
          const n = notes[i]
          if (n) next.add(n.id)
        }
        setSelectedIds(next)
      }

      // Edge auto-scroll loop: runs only while the pointer sits in the edge
      // zone mid-drag. Each tick scrolls and re-applies the range (the
      // content rect has moved, so curY changes even with a still pointer).
      const tick = () => {
        raf = 0
        if (!active) return
        const rect = scrollerEl.getBoundingClientRect()
        let v = 0
        if (lastClientY < rect.top + EDGE_ZONE_PX) {
          v = -Math.min(EDGE_SCROLL_MAX, Math.ceil((rect.top + EDGE_ZONE_PX - lastClientY) / 2))
        } else if (lastClientY > rect.bottom - EDGE_ZONE_PX) {
          v = Math.min(EDGE_SCROLL_MAX, Math.ceil((lastClientY - (rect.bottom - EDGE_ZONE_PX)) / 2))
        }
        if (v !== 0) {
          scrollerEl.scrollTop += v
          applyRange()
          raf = requestAnimationFrame(tick)
        }
      }

      const onMove = (ev: PointerEvent) => {
        lastClientY = ev.clientY
        if (!active) {
          if (Math.abs(ev.clientY - startClientY) < DRAG_THRESHOLD_PX) return
          active = true
          // Suppress text selection for the drag's duration — the pointer
          // sweeps across bubble text and would otherwise paint selections.
          document.body.style.userSelect = 'none'
        }
        applyRange()
        if (raf === 0) raf = requestAnimationFrame(tick)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (raf !== 0) cancelAnimationFrame(raf)
        document.body.style.userSelect = ''
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [scrollerEl, contentRef, virtualizer, notes, selectedIdsRef, setSelectedIds],
  )

  return { onGutterPointerDown }
}
