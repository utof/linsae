import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

/**
 * How long the pill stays lit after the last position change, ms.
 *
 * Literally the feed pill's idle window (`feed/Feed.tsx:903`), so the app has ONE
 * "you are scrolling" rhythm. Re-declared rather than imported because that value is
 * module-local there, and reaching into the feed from the PDF pane would couple two
 * unrelated surfaces (the same call `PdfReader`'s `FLASH_MS` makes).
 */
const IDLE_MS = 800

/**
 * What the pill recedes to once scrolling stops — NOT 0.
 *
 * `ScrollDatePill` fades to 0 (`feed/DatePills.tsx:71`), but that pill is
 * `aria-hidden` + `pointerEvents: 'none'` — pure decoration. This one is the
 * jump-to-page control, and `opacity: 0` does not disable hit-testing: a transparent
 * pill would still swallow clicks and drag-selections in the corner of the reader,
 * while making it click-through as well would leave the jump affordance permanently
 * unreachable except mid-scroll. Receding is the only reading of "fades on scroll
 * idle" that keeps the control both discoverable and out of the way.
 */
const IDLE_OPACITY = 0.4

/**
 * Shared pill geometry. A near-copy of `feed/DatePills.tsx`'s `pillBase`, which is
 * module-local there; the mono family is the one deliberate divergence — a
 * proportional face re-flows the pill on every digit change during a scroll, and the
 * design system reserves Geist Mono for numeric/technical runs (`SKILL.md` §Type).
 */
const pillBase = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 500,
  padding: '3px 10px',
  borderRadius: 'var(--r-pill)',
  whiteSpace: 'nowrap',
  background: 'var(--bg-0)',
  border: '1px solid var(--border-0)',
  color: 'var(--fg-1)',
  boxShadow: 'var(--shadow-2)',
  lineHeight: 1.4,
} as const

/** The reader's handle on the indicator. @see PageIndicator */
export interface PageIndicatorHandle {
  /**
   * Display `page`, and hold the pill lit for another `IDLE_MS`.
   *
   * Called from the reader's scroll handler, so the unchanged-page path must be
   * cheap: both `setState`s are same-value bail-outs then, and re-arming the idle
   * timer touches a ref rather than state.
   */
  report: (page: number) => void
}

export interface PageIndicatorProps {
  /** Length of the open document — the denominator, and the jump clamp's ceiling. */
  numPages: number
  /**
   * Commit a jump to a 1-based page. Deliberately unclamped here: the READER owns
   * the clamp, because it is the reader that would otherwise hand an out-of-range
   * page to `readAnchorItem` (`PdfReader.jumpToPage`).
   */
  onJump: (page: number) => void
  /**
   * React 19 ref-as-prop — no `forwardRef`.
   * @see https://react.dev/blog/2024/04/25/react-19
   */
  ref?: Ref<PageIndicatorHandle>
}

/**
 * The reader's floating page counter and jump-to-page control: `42 / 517`, bottom
 * right, receding when scrolling stops. Click it to type a page.
 *
 * **Why the current page arrives through a ref handle rather than a prop.** The
 * reader's live position lives in `anchorRef` — a REF on purpose, written on every
 * scroll frame precisely so a scroll never re-renders the virtualized pane
 * (`PdfReader.tsx`, `anchorRef`). But an indicator has to *render* that number, so
 * something must re-render. Hoisting the anchor to reader state would re-render all
 * N windowed pages per frame and undo that decision; instead the reader pushes the
 * page into this one leaf through {@link PageIndicatorHandle.report}, and only this
 * component re-renders — and only when the integer page actually changes, since
 * `setPage` with an unchanged value is a React bail-out.
 *
 * @see docs/plans/v0.8-multipage-pdf.md §Task 6.1
 * @issue utof/linsae#154
 */
export function PageIndicator({ numPages, onJump, ref }: PageIndicatorProps): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [lit, setLit] = useState(false)
  /** The in-progress input value, or `null` when not editing. */
  const [draft, setDraft] = useState<string | null>(null)
  const idleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      report: (p: number) => {
        setPage(p)
        setLit(true)
        clearTimeout(idleRef.current)
        idleRef.current = setTimeout(() => setLit(false), IDLE_MS)
      },
    }),
    [],
  )

  // The idle timer must not outlive the component: the reader keys this by `pdfId`,
  // so a document swap unmounts it while a timer is very likely still armed.
  useEffect(() => () => clearTimeout(idleRef.current), [])

  const editing = draft !== null
  // Focus and select on ENTERING edit mode, so the first keystroke replaces the
  // current page instead of appending to it. Keyed on the boolean, not on `draft` —
  // keying on the value would re-select after every keystroke. `select()` does not
  // focus on its own (HTML spec: it sets the selection range and fires `select`).
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const commit = useCallback(() => {
    const n = Number.parseInt(draft ?? '', 10)
    setDraft(null)
    // A blank or non-numeric entry cancels rather than jumping: `Number.parseInt('')`
    // is NaN, and NaN would clamp to page 1 downstream — silently teleporting the
    // reader to the top for what the user experienced as a no-op.
    if (Number.isFinite(n)) onJump(n)
  }, [draft, onJump])

  return (
    // A ZERO-HEIGHT sticky rail. `position: absolute` is the wrong tool inside a
    // scroll container: such a child is positioned against the padding box but still
    // scrolls with the content, so `bottom` would ride away on the first wheel notch.
    // Sticky is the idiom this pane already uses for its excerpt bar
    // (`PdfReader.tsx` — `position: sticky; bottom: 0`). Height 0 so the rail
    // contributes nothing to the scroller's content size, which must stay exactly the
    // virtualizer's `getTotalSize()` spacer.
    <div style={{ position: 'sticky', bottom: 0, height: 0, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          right: 'var(--space-4)',
          bottom: 'var(--space-4)',
          // Re-enabled on the control itself: the rail spans the full width and must
          // not intercept a drag-selection that ends near the bottom of the page.
          pointerEvents: 'auto',
          opacity: lit || editing ? 1 : IDLE_OPACITY,
          transition: 'opacity 220ms var(--ease-out)',
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            data-testid="pdf-page-input"
            aria-label="page number"
            // `text` + `inputMode`, not `type="number"`: the number spinner's UA chrome
            // does not fit a 22px pill, and its value would be '' for anything
            // non-numeric — losing the keystrokes this cancels on.
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setDraft(null)
              // React's `stopPropagation` calls the NATIVE one too
              // (`react-dom-client.development.js:3394-3402`), and React's root
              // listener sits below `document` — so this keeps keystrokes typed here
              // from reaching the app's bubble-phase document hotkeys. Not
              // hypothetical: `feed/Feed.tsx:336` acts on Escape and `:657` on `x`
              // with no typing-target guard (unlike `feed/SelectionBar.tsx:92`).
              // Capture-phase listeners still run — they fire before this.
              e.stopPropagation()
            }}
            // Clicking away is a cancel, not a commit — the same contract as Escape,
            // and the one that cannot lose the user's place by accident.
            onBlur={() => setDraft(null)}
            style={{ ...pillBase, width: 64, textAlign: 'center', outline: 'none' }}
          />
        ) : (
          <button
            type="button"
            data-testid="pdf-page-indicator"
            aria-label="jump to page"
            onClick={() => setDraft(String(page))}
            style={{ ...pillBase, cursor: 'pointer' }}
          >
            {page} / {numPages}
          </button>
        )}
      </div>
    </div>
  )
}
