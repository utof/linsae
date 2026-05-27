import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

/**
 * Custom scrollbar overlay — replaces native Chromium scrollbars on every
 * internal scroll surface (Feed/Virtuoso, CommandPalette results,
 * BacklinksPane).
 *
 * Why custom (not a library): every native-scrollbar library evaluated
 * (overlayscrollbars-react, @radix-ui/react-scroll-area, simplebar-react,
 * react-custom-scrollbars-2, react-scrollbars-custom, react-perfect-scrollbar)
 * listens to the raw DOM `scroll` event for show/hide. Virtuoso's
 * programmatic `scrollTop = value` (followOutput, scrollToIndex, resize-
 * driven re-pins) fires `scroll` without the user touching anything — every
 * library would flash the scrollbar constantly on a chat feed. The clean
 * filter is `wheel` events with `event.isTrusted === true`: trusted only
 * for genuine pointer/trackpad input, and Virtuoso's scrollTop assignment
 * fires `scroll` but NOT `wheel`. See ADR 0003 for the full library survey.
 *
 * Why bouncy easing works here (and not on native scrollbars): the thumb is
 * a real `<div>`, not a `::-webkit-scrollbar-thumb` pseudo-element. CSS
 * transitions on real elements honor `cubic-bezier(0.34, 1.56, 0.64, 1)`
 * (spring overshoot) — pseudo-element transitions are silently dropped by
 * Chromium (https://bugs.chromium.org/p/chromium/issues/detail?id=625354).
 *
 * @see adrs/0003-roll-own-scrollbar.md
 */

// Idle timeout (ms) before the thumb fades out after the last user
// interaction. User-tunable — 1500ms keeps the thumb visible during
// continuous scroll sessions but doesn't linger when the user pauses
// for a second or two even with the cursor still over the scroll area.
const FADE_HOLD_MS = 1500
const THUMB_MIN_HEIGHT = 24
const THUMB_BASE_WIDTH = 4
const THUMB_HOVER_WIDTH = 8
const SCROLL_KEYS = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
])

const SPRING_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

interface ThumbGeometry {
  thumbTop: number
  thumbHeight: number
  visible: boolean
}

/**
 * Attaches a custom-scrollbar driver to an external scrollable element
 * (typically Virtuoso's `scrollerRef` callback target). Returns the
 * computed thumb geometry + hover/drag callbacks the caller can wire to
 * a `<div>` thumb placed in their own layout.
 *
 * Surfaces that own their scroll container directly (BacklinksPane,
 * CommandPalette) should use `<ScrollArea>` below instead — it does the
 * wiring for you.
 */
export function useScrollThumb(scrollEl: HTMLElement | null): {
  geometry: ThumbGeometry
  thumbHovered: boolean
  areaHovered: boolean
  setThumbHovered: (v: boolean) => void
  onAreaEnter: () => void
  onAreaLeave: () => void
  onThumbPointerDown: (e: ReactPointerEvent) => void
} {
  const [geometry, setGeometry] = useState<ThumbGeometry>({
    thumbTop: 0,
    thumbHeight: 0,
    visible: false,
  })
  const [thumbHovered, setThumbHovered] = useState(false)
  const [areaHovered, setAreaHovered] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const thumbHeightRef = useRef(0)

  const recompute = useCallback(() => {
    if (!scrollEl) return
    const { scrollTop, scrollHeight, clientHeight } = scrollEl
    if (scrollHeight <= clientHeight + 1) {
      thumbHeightRef.current = 0
      setGeometry((g) => (g.thumbHeight === 0 ? g : { ...g, thumbHeight: 0, thumbTop: 0 }))
      return
    }
    const ratio = clientHeight / scrollHeight
    const thumbHeight = Math.max(ratio * clientHeight, THUMB_MIN_HEIGHT)
    const maxScroll = scrollHeight - clientHeight
    const maxThumbTop = clientHeight - thumbHeight
    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxThumbTop : 0
    thumbHeightRef.current = thumbHeight
    setGeometry((g) => ({ ...g, thumbTop, thumbHeight }))
  }, [scrollEl])

  const showAndQueueHide = useCallback(() => {
    setGeometry((g) => (g.visible ? g : { ...g, visible: true }))
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      setGeometry((g) => ({ ...g, visible: false }))
      hideTimer.current = null
    }, FADE_HOLD_MS)
  }, [])

  useEffect(() => {
    if (!scrollEl) return
    recompute()
    const onScroll = () => recompute()
    const onWheel = (e: WheelEvent) => {
      if (e.isTrusted) showAndQueueHide()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.isTrusted) return
      if (SCROLL_KEYS.has(e.key)) showAndQueueHide()
    }
    const ro = new ResizeObserver(recompute)
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    scrollEl.addEventListener('wheel', onWheel, { passive: true })
    scrollEl.addEventListener('keydown', onKeyDown)
    ro.observe(scrollEl)
    // Observe the immediate children too — Virtuoso adds/removes virtualized
    // item nodes which change scrollHeight without the scroller itself
    // resizing. Observing the scroller alone misses those updates.
    for (const child of Array.from(scrollEl.children)) {
      ro.observe(child)
    }
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      scrollEl.removeEventListener('wheel', onWheel)
      scrollEl.removeEventListener('keydown', onKeyDown)
      ro.disconnect()
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
    }
  }, [scrollEl, recompute, showAndQueueHide])

  const onThumbPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!scrollEl) return
      e.preventDefault()
      e.stopPropagation()
      const startY = e.clientY
      const startScrollTop = scrollEl.scrollTop
      const { scrollHeight, clientHeight } = scrollEl
      const maxScroll = scrollHeight - clientHeight
      const maxThumbTop = clientHeight - thumbHeightRef.current
      const dragRatio = maxThumbTop > 0 ? maxScroll / maxThumbTop : 0
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY
        scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, startScrollTop + dy * dragRatio))
        showAndQueueHide()
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [scrollEl, showAndQueueHide],
  )

  // Combined enter/leave handlers so callers can wire pointer-enter to a
  // single function that both flags the area-hover state (for transition-
  // speed selection) AND triggers the show + queues the idle hide. Cursor
  // sitting still in the scroll area without scrolling fades out after
  // FADE_HOLD_MS; this is intentional — see file-level rationale.
  const onAreaEnter = useCallback(() => {
    setAreaHovered(true)
    showAndQueueHide()
  }, [showAndQueueHide])
  const onAreaLeave = useCallback(() => {
    setAreaHovered(false)
  }, [])

  return {
    geometry,
    thumbHovered,
    areaHovered,
    setThumbHovered,
    onAreaEnter,
    onAreaLeave,
    onThumbPointerDown,
  }
}

interface ThumbProps {
  geometry: ThumbGeometry
  thumbHovered: boolean
  areaHovered: boolean
  setThumbHovered: (v: boolean) => void
  onPointerDown: (e: ReactPointerEvent) => void
  /** Override the right offset (in px) — useful when the scroller has
   * inner horizontal padding and the thumb should sit at the visual edge. */
  rightOffset?: number
}

/**
 * Renders just the thumb overlay — absolute-positioned, sibling of the
 * scroller, parent must be `position: relative`. Surfaces using
 * `useScrollThumb` directly (Feed/Virtuoso) compose this themselves;
 * `<ScrollArea>` below uses it internally.
 */
export function ScrollThumb({
  geometry,
  thumbHovered,
  areaHovered,
  setThumbHovered,
  onPointerDown,
  rightOffset = 2,
}: ThumbProps) {
  if (geometry.thumbHeight === 0) return null
  // areaHovered is NOT in `show` — hovering the area without scrolling
  // should NOT keep the thumb visible indefinitely (the timer must be
  // allowed to expire). Direct thumbHovered is still an override because
  // cursor-over-thumb is an explicit "about to drag" intent.
  const show = geometry.visible || thumbHovered
  const width = thumbHovered ? THUMB_HOVER_WIDTH : THUMB_BASE_WIDTH
  return (
    <div
      aria-hidden
      onPointerEnter={() => setThumbHovered(true)}
      onPointerLeave={() => setThumbHovered(false)}
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        top: geometry.thumbTop,
        right: rightOffset,
        width,
        height: geometry.thumbHeight,
        background: thumbHovered ? 'var(--fg-3)' : 'var(--border-2)',
        borderRadius: 4,
        opacity: show ? 1 : 0,
        // Bouncy width transition via spring-overshoot cubic-bezier; opacity
        // fade-in is faster (120ms) when the area is hovered for snappy
        // feedback, normal (280ms) for the show-on-scroll case.
        transition: `width 240ms ${SPRING_EASE}, opacity ${areaHovered || thumbHovered ? 120 : 280}ms ease, background 120ms ease`,
        cursor: 'pointer',
        touchAction: 'none',
        pointerEvents: show ? 'auto' : 'none',
      }}
    />
  )
}

interface ScrollAreaProps {
  children: ReactNode
  style?: CSSProperties
  className?: string
  /** Inline style applied to the inner scroll element (e.g. `maxHeight`,
   * `padding`). The native scrollbar is always hidden on this element. */
  scrollStyle?: CSSProperties
}

/**
 * Drop-in scrollable wrapper for surfaces that own their own scroll
 * container (BacklinksPane, CommandPalette). The outer div is the
 * positioning anchor; the inner div owns the scrolling; the absolute
 * thumb is rendered as a sibling of the scroll content.
 *
 * For Virtuoso, use `useScrollThumb` + `<ScrollThumb>` directly — the
 * Virtuoso scroller is captured via its `scrollerRef` callback.
 */
export function ScrollArea({ children, style, className, scrollStyle }: ScrollAreaProps) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const driver = useScrollThumb(scrollEl)

  return (
    <div
      className={className}
      onPointerEnter={driver.onAreaEnter}
      onPointerLeave={driver.onAreaLeave}
      style={{ position: 'relative', ...style }}
    >
      <div
        ref={setScrollEl}
        className="scroll-area-inner"
        style={{
          height: '100%',
          width: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          scrollbarWidth: 'none',
          ...scrollStyle,
        }}
      >
        {children}
      </div>
      <ScrollThumb
        geometry={driver.geometry}
        thumbHovered={driver.thumbHovered}
        areaHovered={driver.areaHovered}
        setThumbHovered={driver.setThumbHovered}
        onPointerDown={driver.onThumbPointerDown}
      />
    </div>
  )
}
