/**
 * AnnotateEditor — the modal drawing editor over a captured frame.
 *
 * A modal that renders an enlarged 16:9 frame (base `<img>` + interactive
 * `<SceneSvg>`) with a toolbar (pen · text · eraser · color swatches · Done /
 * Cancel). Holds the working `Scene` in local state. On Done it persists via
 * `saveOverlay` (empty scene → `null` clears the sidecar; non-empty →
 * serialized SVG).
 *
 * **Tools**
 * - **Pen**: pointerdown/move/up appends a `Stroke`. Points are captured in
 *   image-pixel space via `clientToImagePoint`. `PointerEvent.pressure` →
 *   `InkPoint.pressure` (fallback 0.5). `simulatePressure` is set from the
 *   pointer type: `false` for `pointerType === 'pen'` (trust the stylus's real
 *   pressure), `true` for mouse/touch (let perfect-freehand simulate). See
 *   `ink/stroke.ts#strokeToPath`.
 * - **Text**: clicking places a `TextBlock`; an inline editable `<div>` captures
 *   the text; the active swatch sets its color.
 * - **Eraser (whole-stroke)**: pointerdown/enter on any element removes it from
 *   the scene by `id` (native per-element pointer hit-testing — no geometry).
 *
 * **Undo (`Cmd/Ctrl+Z`)**: a snapshot stack of `scene.elements` is pushed before
 * each mutation; undo pops it. Uniformly reverts any action (add/erase/move).
 * No redo (YAGNI — spec §AnnotateEditor).
 *
 * **StrictMode safety (spec §Risks):** the stroke-in-progress lives in a `ref`
 * (not state), committed to scene state on pointerup, so a double-mount cannot
 * duplicate or drop a stroke.
 *
 * **Coordinate mapping:** `clientToImagePoint` (the SVG CTM inverse) maps the
 * pointer to `viewBox` units so strokes store image-pixel coordinates regardless
 * of container size / letterboxing.
 *
 * **Default stroke size** is scaled by `attachment.device_pixel_ratio` so a
 * default pen reads the same relative thickness on a DPR-2 capture as a DPR-1
 * one (sizes are in image-pixel space; `width_px = rect × scaleFactor`).
 *
 * `crypto.randomUUID()` ids are minted HERE (not in `ink/` — that module is
 * context-free and mints nothing).
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §AnnotateEditor
 * @see src/renderer/src/ink/coords.ts (clientToImagePoint)
 * @see src/renderer/src/ink/stroke.ts (STROKE_OPTS, strokeToPath)
 * @see src/renderer/src/annotate/useOverlay.ts (saveOverlay)
 */

import { useQueryClient } from '@tanstack/react-query'
import { Check, Eraser, Pen, Type, Undo2, X } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Attachment } from '../../../shared/types'
import { clientToImagePoint } from '../ink/coords'
import { SceneSvg } from '../ink/SceneSvg'
import type { InkPoint, Scene, SceneElement, Stroke, TextBlock } from '../ink/types'
import { mediaUrlFromPath } from '../lib/media-url'
import { saveOverlay } from './useOverlay'

// The only blessed hardcoded color in the media frame area (matches Rail/AnnotatedFrame).
const MEDIA_BG = '#1c1c1e'

/** Default pen size in image-pixel space at DPR 1 (feel-only; scaled by DPR). */
const BASE_STROKE_SIZE = 8

/** Default text font size in image-pixel space at DPR 1 (scaled by DPR). */
const BASE_FONT_SIZE = 28

/** Default wrap width for a placed text block, image-pixel space (scaled by DPR). */
const BASE_TEXT_WIDTH = 240

/**
 * Swatch palette — accent first (the v21 brand hue), then a small set of status
 * hues for markup contrast. Accent is the default ("accent marks current").
 * @see src/renderer/src/styles/colors_and_type.css
 */
const SWATCHES = ['#0D99FF', '#E5484D', '#30A46C', '#8E4EC6', '#1E1E1E'] as const

type Tool = 'pen' | 'text' | 'eraser'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Which Esc-prompt the editor shows (the two entry flows differ — spec §Key flows):
 * - `'changes'` (reopen a posted screenshot): Esc with unsaved edits → "Discard
 *   changes?" → Discard reverts to the saved scene (close without save; the
 *   sidecar/note persist). Esc with NO unsaved edits closes immediately.
 * - `'orphan'` (capture-time, never posted): Esc → "Discard / Keep as orphan" →
 *   Keep saves the scene if non-empty then leaves the orphan; Discard calls
 *   `onDiscardOrphan` (the capture flow soft-deletes the orphan row + sidecar).
 */
type EscMode = 'changes' | 'orphan'

export interface AnnotateEditorProps {
  /** The screenshot attachment being annotated. */
  attachment: Attachment
  /**
   * The scene to edit. `null` (or an empty scene) starts a blank overlay sized
   * to the attachment. On reopen, the caller passes the parsed saved scene.
   */
  initialScene: Scene | null
  /**
   * Called when the editor finishes (Done/Keep after save, or Cancel/Discard
   * without save). The caller unmounts the modal. `saved` reports whether a save
   * happened, so a capture-time caller can distinguish a saved frame from a
   * discarded/cancelled one for chip wiring.
   */
  onClose: (saved: boolean) => void
  /**
   * Which Esc prompt to show. Defaults to `'changes'` (reopen flow).
   * @see EscMode
   */
  escMode?: EscMode
  /**
   * Capture-time only (`escMode: 'orphan'`): called when the user chooses
   * **Discard** on the Esc prompt. The capture flow soft-deletes the orphan
   * attachment row + its sidecar via `attachments.remove`. Ignored in `'changes'`
   * mode (a posted screenshot is never soft-deleted from the editor).
   */
  onDiscardOrphan?: () => void
  /**
   * Fired with the freshly-written `overlay_path` (or `null` when the scene is
   * empty/cleared) right before `onClose(true)`. The capture flow uses it to
   * synthesize the pending chip's Attachment with the new sidecar (B-2); the
   * reopen flow ignores it (it re-reads via query invalidation instead).
   */
  onSaved?: (overlayPath: string | null) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The modal drawing editor. See module docs for behavior.
 * @see docs/specs/v0.2.5-screenshot-annotation.md §AnnotateEditor
 */
export function AnnotateEditor({
  attachment,
  initialScene,
  onClose,
  escMode = 'changes',
  onDiscardOrphan,
  onSaved,
}: AnnotateEditorProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const dpr = attachment.device_pixel_ratio || 1

  // The working scene. width/height define the SVG viewBox (= image pixels).
  const [scene, setScene] = useState<Scene>(() => ({
    width: initialScene?.width || attachment.width_px,
    height: initialScene?.height || attachment.height_px,
    elements: initialScene?.elements ?? [],
  }))

  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState<string>(SWATCHES[0])
  const [saving, setSaving] = useState(false)
  // True once the user has mutated the scene this session (drives the reopen
  // "Discard changes?" prompt — Esc with no edits just closes).
  const [dirty, setDirty] = useState(false)
  // When set, an Esc-prompt confirmation overlay is shown.
  const [escPrompt, setEscPrompt] = useState(false)

  // Undo snapshot stack — full-element-array snapshots pushed BEFORE each
  // mutation. Scenes are tiny (screenshot markup), so this is trivial.
  const undoStack = useRef<SceneElement[][]>([])

  // Stroke-in-progress lives in a REF (StrictMode safety, spec §Risks): a
  // double-mount cannot duplicate or drop a stroke because the in-flight points
  // never touch render state until pointerup commits them.
  const drawing = useRef<{ points: InkPoint[]; simulatePressure: boolean } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // True while the eraser pointer is held down (erase-on-enter while dragging).
  const erasing = useRef(false)

  /** Push the current elements onto the undo stack before mutating + mark dirty. */
  const snapshot = useCallback(() => {
    undoStack.current.push(scene.elements)
    setDirty(true)
  }, [scene.elements])

  // ── undo (Cmd/Ctrl+Z) ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault()
        const prev = undoStack.current.pop()
        if (prev !== undefined) setScene((s) => ({ ...s, elements: prev }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── coordinate helper ───────────────────────────────────────────────────────
  const toImage = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: clientX, y: clientY }
    const p = clientToImagePoint(svg, clientX, clientY)
    return { x: p.x, y: p.y }
  }, [])

  // ── erase one element by id (eraser tool) ───────────────────────────────────
  const eraseById = useCallback(
    (id: string) => {
      snapshot()
      setScene((s) => ({ ...s, elements: s.elements.filter((el) => el.id !== id) }))
    },
    [snapshot],
  )

  // ── per-element handlers (eraser only; passed into SceneSvg) ────────────────
  const onElementPointerDown = useCallback(
    (id: string, e: ReactPointerEvent) => {
      if (tool !== 'eraser') return
      e.stopPropagation()
      erasing.current = true
      eraseById(id)
    },
    [tool, eraseById],
  )
  const onElementPointerEnter = useCallback(
    (id: string, _e: ReactPointerEvent) => {
      if (tool !== 'eraser' || !erasing.current) return
      eraseById(id)
    },
    [tool, eraseById],
  )

  // ── surface (svg) pointer handlers — pen draw + text placement ──────────────
  const onSurfacePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (tool === 'eraser') {
        // pointerdown on empty surface (not an element) — arm drag-erase.
        erasing.current = true
        return
      }
      const { x, y } = toImage(e.clientX, e.clientY)
      if (tool === 'text') {
        snapshot()
        const block: TextBlock = {
          id: crypto.randomUUID(),
          kind: 'text',
          x,
          y,
          width: BASE_TEXT_WIDTH * dpr,
          height: BASE_FONT_SIZE * dpr * 1.4,
          text: '',
          color,
          fontSize: BASE_FONT_SIZE * dpr,
        }
        setScene((s) => ({ ...s, elements: [...s.elements, block] }))
        return
      }
      // pen
      const pressure = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5
      drawing.current = {
        points: [{ x, y, pressure }],
        simulatePressure: e.pointerType !== 'pen',
      }
      // Capture the pointer so moves outside the svg still feed the stroke.
      try {
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
      } catch {
        // happy-dom / detached targets: capture is best-effort.
      }
    },
    [tool, toImage, snapshot, color, dpr],
  )

  const onSurfacePointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (tool !== 'pen' || drawing.current === null) return
      const { x, y } = toImage(e.clientX, e.clientY)
      const pressure = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5
      drawing.current.points.push({ x, y, pressure })
    },
    [tool, toImage],
  )

  const onSurfacePointerUp = useCallback(() => {
    erasing.current = false
    const inFlight = drawing.current
    drawing.current = null
    if (tool !== 'pen' || inFlight === null || inFlight.points.length < 2) return
    snapshot()
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      kind: 'stroke',
      points: inFlight.points,
      color,
      size: BASE_STROKE_SIZE * dpr,
      simulatePressure: inFlight.simulatePressure,
    }
    setScene((s) => ({ ...s, elements: [...s.elements, stroke] }))
  }, [tool, snapshot, color, dpr])

  // ── text editing (contentEditable) ──────────────────────────────────────────
  const editText = useCallback((id: string, text: string) => {
    setDirty(true)
    setScene((s) => ({
      ...s,
      elements: s.elements.map((el) => (el.id === id && el.kind === 'text' ? { ...el, text } : el)),
    }))
  }, [])

  // ── recolor (active swatch applies to new elements) ─────────────────────────
  const pickColor = useCallback((c: string) => {
    setColor(c)
  }, [])

  // ── persist (shared by Done + Esc-Keep) ─────────────────────────────────────
  const isEmpty = scene.elements.length === 0
  // Save then close. Empty scene → null clears overlay_path + removes the
  // sidecar; non-empty → serialized SVG. saveOverlay handles serialize + cache
  // invalidation. Guarded by `saving` to avoid a double-submit.
  const saveAndClose = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      const { overlayPath } = await saveOverlay(queryClient, attachment, isEmpty ? null : scene)
      onSaved?.(overlayPath)
      onClose(true)
    } finally {
      setSaving(false)
    }
  }, [saving, queryClient, attachment, isEmpty, scene, onClose, onSaved])

  // ── Done / Cancel ───────────────────────────────────────────────────────────
  const onDone = saveAndClose

  const onCancel = useCallback(() => {
    onClose(false)
  }, [onClose])

  // ── Esc prompt actions ──────────────────────────────────────────────────────
  // 'orphan' (capture): Keep saves if non-empty then leaves the orphan; Discard
  // soft-deletes via onDiscardOrphan. 'changes' (reopen): Discard reverts to the
  // saved scene (close without save — sidecar untouched).
  const escKeep = useCallback(() => {
    setEscPrompt(false)
    if (isEmpty) {
      // Nothing drawn — keep the bare orphan; no sidecar written (v0.2.0 parity).
      onClose(false)
    } else {
      void saveAndClose()
    }
  }, [isEmpty, onClose, saveAndClose])

  const escDiscard = useCallback(() => {
    setEscPrompt(false)
    if (escMode === 'orphan') onDiscardOrphan?.()
    onClose(false)
  }, [escMode, onDiscardOrphan, onClose])

  const escDismiss = useCallback(() => setEscPrompt(false), [])

  // ── Esc key ───────────────────────────────────────────────────────────────
  // 'changes' + not dirty → close immediately (nothing to lose). Otherwise open
  // the confirmation prompt. A second Esc while the prompt is open dismisses it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (escPrompt) {
        setEscPrompt(false)
        return
      }
      if (escMode === 'changes' && !dirty) {
        onClose(false)
        return
      }
      setEscPrompt(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escPrompt, escMode, dirty, onClose])

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Annotation editor"
      data-testid="annotate-editor"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        background: 'rgba(0,0,0,0.55)',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderRadius: 'var(--r-4)',
          background: 'var(--bg-0)',
          boxShadow: 'var(--shadow-2)',
        }}
      >
        <ToolButton label="Pen" active={tool === 'pen'} onClick={() => setTool('pen')}>
          <Pen size={16} />
        </ToolButton>
        <ToolButton label="Text" active={tool === 'text'} onClick={() => setTool('text')}>
          <Type size={16} />
        </ToolButton>
        <ToolButton label="Eraser" active={tool === 'eraser'} onClick={() => setTool('eraser')}>
          <Eraser size={16} />
        </ToolButton>

        <span style={{ width: 1, height: 22, background: 'var(--border-0)' }} />

        {/* Color swatches — active swatch uses an accent ring. */}
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`color ${c}`}
            aria-pressed={color === c}
            onClick={() => pickColor(c)}
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: c,
              cursor: 'pointer',
              padding: 0,
              border: color === c ? '2px solid var(--accent)' : '2px solid var(--bg-0)',
              boxShadow: color === c ? 'var(--shadow-focus)' : '0 0 0 1px var(--border-1)',
            }}
          />
        ))}

        <span style={{ width: 1, height: 22, background: 'var(--border-0)' }} />

        <ToolButton
          label="Undo"
          active={false}
          onClick={() => {
            const prev = undoStack.current.pop()
            if (prev !== undefined) setScene((s) => ({ ...s, elements: prev }))
          }}
        >
          <Undo2 size={16} />
        </ToolButton>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          aria-label="cancel"
          onClick={onCancel}
          style={chromeButtonStyle(false)}
        >
          <X size={15} /> Cancel
        </button>
        <button
          type="button"
          aria-label="done"
          onClick={() => void onDone()}
          disabled={saving}
          style={chromeButtonStyle(true)}
        >
          <Check size={15} /> Done
        </button>
      </div>

      {/* Frame: base img + interactive SceneSvg overlay. */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 'min(90vw, 1280px)',
          aspectRatio: '16 / 9',
          borderRadius: 'var(--r-3)',
          overflow: 'hidden',
          background: MEDIA_BG,
          // Editor cursor reflects the active tool.
          cursor: tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair',
          touchAction: 'none',
        }}
      >
        <img
          src={mediaUrlFromPath(attachment.base_path)}
          alt="frame being annotated"
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
        {/* Interactive overlay — fills the same box. Pointer handlers on the
            wrapping div catch surface (empty-area) gestures; SceneSvg's
            per-element handlers (eraser) take precedence via stopPropagation.
            The drawing surface is a canvas-like region: keyboard interaction
            (undo / done / cancel) lives on the toolbar buttons and the
            window-level Ctrl+Z handler, not on this pointer surface. */}
        <div
          data-testid="annotate-surface"
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        >
          <EditorScene
            ref={svgRef}
            scene={scene}
            onElementPointerDown={onElementPointerDown}
            onElementPointerEnter={onElementPointerEnter}
            onEditText={editText}
            editable={tool === 'text'}
          />
        </div>
      </div>

      {/* Esc confirmation prompt — two flows (spec §Key flows). */}
      {escPrompt && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label={escMode === 'orphan' ? 'Discard or keep' : 'Discard changes'}
          data-testid="annotate-esc-prompt"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
          }}
        >
          <div
            style={{
              minWidth: 280,
              padding: 18,
              borderRadius: 'var(--r-4)',
              background: 'var(--bg-0)',
              boxShadow: 'var(--shadow-3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ fontSize: 14, color: 'var(--fg-0)', lineHeight: 1.5 }}>
              {escMode === 'orphan'
                ? 'discard this capture, or keep it as an orphan?'
                : 'discard unsaved changes?'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                aria-label="keep editing"
                onClick={escDismiss}
                style={chromeButtonStyle(false)}
              >
                keep editing
              </button>
              {escMode === 'orphan' && (
                <button
                  type="button"
                  aria-label="keep as orphan"
                  onClick={escKeep}
                  style={chromeButtonStyle(false)}
                >
                  keep
                </button>
              )}
              <button
                type="button"
                aria-label="discard"
                onClick={escDiscard}
                style={{ ...chromeButtonStyle(false), color: 'var(--status-wtf)' }}
              >
                discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editor scene wrapper — SceneSvg + contentEditable overlays for text blocks.
// ---------------------------------------------------------------------------

/**
 * Renders the interactive `SceneSvg` plus an HTML overlay layer of
 * contentEditable divs for each text block (so text is editable while the SVG
 * provides hit-testing for the eraser). The contentEditable layer is only
 * interactive when the text tool is active.
 *
 * Why a forwardRef to the svg: the editor needs the live `<svg>` element for the
 * coordinate CTM (`clientToImagePoint`).
 */
const EditorScene = (() => {
  // Inner component reads svgRef via a callback ref placed on SceneSvg's svg.
  // SceneSvg doesn't forward a ref, so we locate the svg from the wrapper.
  return function EditorSceneImpl({
    ref,
    scene,
    onElementPointerDown,
    onElementPointerEnter,
    onEditText,
    editable,
  }: {
    ref: React.RefObject<SVGSVGElement | null>
    scene: Scene
    onElementPointerDown: (id: string, e: ReactPointerEvent) => void
    onElementPointerEnter: (id: string, e: ReactPointerEvent) => void
    onEditText: (id: string, text: string) => void
    editable: boolean
  }): React.JSX.Element {
    const wrapRef = useRef<HTMLDivElement>(null)
    // After mount, hand the rendered <svg> to the editor's svgRef for CTM math.
    useEffect(() => {
      const svg = wrapRef.current?.querySelector('svg')
      if (svg) ref.current = svg as SVGSVGElement
    })

    return (
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <SceneSvg
          scene={scene}
          onElementPointerDown={onElementPointerDown}
          onElementPointerEnter={onElementPointerEnter}
        />
        {/* contentEditable overlay for text blocks — positioned in % of the
            viewBox so it aligns with the SceneSvg foreignObjects. Only the text
            tool makes these interactive; otherwise they're pointer-inert so the
            eraser/pen reach the SVG beneath. */}
        {scene.elements.map((el) =>
          el.kind === 'text' ? (
            // biome-ignore lint/a11y/useSemanticElements: a free-positioned multiline rich-text caption overlaid on the SVG needs contentEditable (an <input>/<textarea> can't be absolutely placed in viewBox-% space with auto-grow); role="textbox" is the correct ARIA mapping.
            <div
              key={el.id}
              data-testid={`text-edit-${el.id}`}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-label="annotation text"
              tabIndex={0}
              onInput={(e) => onEditText(el.id, (e.target as HTMLElement).textContent ?? '')}
              style={{
                position: 'absolute',
                left: `${(el.x / scene.width) * 100}%`,
                top: `${(el.y / scene.height) * 100}%`,
                width: `${(el.width / scene.width) * 100}%`,
                color: el.color,
                fontSize: `${(el.fontSize / scene.height) * 100}%`,
                outline: editable ? '1px dashed var(--accent)' : 'none',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                pointerEvents: editable ? 'auto' : 'none',
              }}
            >
              {el.text}
            </div>
          ) : null,
        )}
      </div>
    )
  }
})()

// ---------------------------------------------------------------------------
// Toolbar bits
// ---------------------------------------------------------------------------

/** A toolbar tool toggle — accent background marks the active (current) tool. */
function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 'var(--r-2)',
        border: 0,
        cursor: 'pointer',
        // Accent marks ONLY the current tool (v21 "accent marks current").
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--fg-1)',
      }}
    >
      {children}
    </button>
  )
}

/** Chrome button (Done = accent / primary; Cancel = neutral). */
function chromeButtonStyle(primary: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 32,
    padding: '0 12px',
    borderRadius: 'var(--r-2)',
    fontSize: 13,
    cursor: 'pointer',
    border: primary ? 0 : '1px solid var(--border-1)',
    background: primary ? 'var(--accent)' : 'var(--bg-0)',
    color: primary ? '#fff' : 'var(--fg-1)',
  }
}
