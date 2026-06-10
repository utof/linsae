/**
 * Read-only frame display: a base screenshot with an optional annotation overlay.
 *
 * Composes `useOverlayScene` (fetch + parse the sidecar) and `SceneSvg` (inert
 * overlay, no pointer handlers). When `onReopen` is supplied a hover pencil
 * button top-right opens the editor (T4 concern; T3 wires the button and calls
 * the callback — the editor itself is T4).
 *
 * Layout: a `position: relative` container with `aspect-ratio: 16 / 9`. The base
 * `<img>` fills the container (unchanged styling from `Rail.tsx:128-132`). The
 * `<SceneSvg>` is absolutely positioned and fills the same bounding box via
 * `inset: 0; width: 100%; height: 100%`.
 *
 * The pencil button is always in the DOM when `onReopen` is supplied; its
 * opacity is driven by container-level hover/focus state so hovering anywhere on
 * the frame reveals it, and it stays reachable by tests and keyboard users.
 *
 * Why no editor in T3: the editor (`AnnotateEditor`) is T4. T3 only needs
 * saved overlays to appear read-only. `onReopen` is wired to a callback so T4
 * can mount the modal there without touching this component.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §AnnotatedFrame
 * @see src/renderer/src/annotate/useOverlay.ts
 * @see src/renderer/src/ink/SceneSvg.tsx
 */

import { Pencil } from 'lucide-react'
import { useState } from 'react'
import type { Attachment } from '../../../shared/types'
import { SceneSvg } from '../ink/SceneSvg'
import { mediaUrlFromPath } from '../lib/media-url'
import { useOverlayScene } from './useOverlay'

// The only blessed hardcoded color in the media frame area (matches Rail.tsx MEDIA_BG).
const MEDIA_BG = '#1c1c1e'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AnnotatedFrameProps {
  /** The screenshot attachment to display. */
  attachment: Attachment
  /**
   * When supplied, a hover pencil button (top-right) appears and calls this
   * callback when clicked — the caller mounts the editor.
   * T3 decision: `onReopen` is accepted by the component but Rail.tsx omits it
   * in T3 (no dead handler ships). T4 will pass it.
   * Why: spec §Rail.tsx integration: "prefer omitting onReopen in T3 so no dead
   * handler ships; T4 adds it."
   */
  onReopen?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Positioned 16:9 container: base `<img>` + optional inert `<SceneSvg>` +
 * optional hover pencil button (onReopen).
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §AnnotatedFrame
 */
export function AnnotatedFrame({ attachment, onReopen }: AnnotatedFrameProps): React.JSX.Element {
  const { scene } = useOverlayScene(attachment)
  // Hover-reveal lives at CONTAINER level so hovering anywhere on the frame
  // reveals the pencil (a button-only listener would never fire while the button
  // is opacity:0). Keyboard focus reveals it too (focusVisible) for a11y.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const reopenVisible = hovered || focused

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-enter/leave here are purely cosmetic hover-reveal for the pencil button; the actionable, keyboard-accessible target is the inner <button> (which also reveals itself on focus).
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 9',
        overflow: 'hidden',
        borderRadius: 'var(--r-3)',
        background: MEDIA_BG,
      }}
    >
      {/* Base screenshot — styling unchanged from Rail.tsx:128-132 */}
      <img
        src={mediaUrlFromPath(attachment.base_path)}
        alt="captured frame"
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />

      {/* Inert annotation overlay — absolutely fills the container */}
      {scene != null && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            // The div itself must not intercept clicks (SceneSvg already sets
            // pointer-events:none on the svg, but belt-and-suspenders here).
            pointerEvents: 'none',
          }}
        >
          {/* No handlers → SceneSvg is fully inert (pointer-events:none on root svg) */}
          <SceneSvg scene={scene} />
        </div>
      )}

      {/* Hover pencil button — always in DOM so keyboard/test access works */}
      {onReopen != null && (
        <button
          type="button"
          data-testid="annotated-frame-reopen"
          aria-label="Reopen annotation editor"
          onClick={onReopen}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 'var(--r-3)',
            border: '1px solid var(--border-0)',
            background: 'var(--bg-0)',
            color: 'var(--fg-1)',
            cursor: 'pointer',
            // Reveal driven by CONTAINER hover (or keyboard focus). Button is
            // always in DOM for a11y / test access; only its opacity toggles.
            opacity: reopenVisible ? 1 : 0,
            transition: 'opacity var(--dur-1) ease',
          }}
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  )
}
