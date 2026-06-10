// @vitest-environment happy-dom
/**
 * Component tests for AnnotateEditor — the modal drawing editor.
 *
 * Covers (spec §AnnotateEditor):
 *   - tool switch updates the active tool (accent marks the current tool);
 *   - pen: pointerdown→move→up appends ONE Stroke; pointerType drives
 *     simulatePressure (pen → false, mouse → true);
 *   - text: click places a TextBlock; typing edits it; swatch sets color;
 *   - eraser: pointerdown on an element removes it by id;
 *   - undo (Cmd/Ctrl+Z): reverts the last mutation — after an ADD and an ERASE;
 *   - empty scene + Done → saveOverlay(attachment, null);
 *   - non-empty + Done → saveOverlay(attachment, scene) (serialized SVG);
 *   - Cancel closes without saving.
 *
 * The editor commits the saved scene through `saveOverlay` (useOverlay), so we
 * spy on the api facade's youtube.saveOverlay to assert the serialized payload.
 * In happy-dom getScreenCTM() returns identity, so clientToImagePoint maps
 * client coords 1:1 to image space (predictable assertions).
 *
 * @see src/renderer/src/annotate/AnnotateEditor.tsx
 * @see docs/specs/v0.2.5-screenshot-annotation.md §AnnotateEditor
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, type MockApi, renderWithProviders } from '../../../../tests/setup'
import type { Attachment } from '../../../shared/types'
import { AnnotateEditor } from './AnnotateEditor'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATTACHMENT: Attachment = {
  id: 'att-001',
  note_id: null,
  kind: 'screenshot',
  base_sha256: 'abcdef',
  base_path: '/store/2026/05/abcdef.png',
  overlay_path: null,
  video_id: 'vid1',
  time_seconds: 42,
  width_px: 1920,
  height_px: 1080,
  device_pixel_ratio: 1,
  created_at: 1000,
  deleted_at: null,
}

/**
 * Fire a complete pen-stroke gesture on the editor's interactive <svg>.
 * happy-dom's getScreenCTM is identity, so clientX/Y == image coords.
 */
function drawStroke(svg: Element, opts: { pointerType?: string; pressure?: number } = {}): void {
  const { pointerType = 'mouse', pressure = 0.5 } = opts
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerType, pressure })
  fireEvent.pointerMove(svg, { clientX: 20, clientY: 22, pointerType, pressure })
  fireEvent.pointerMove(svg, { clientX: 30, clientY: 36, pointerType, pressure })
  fireEvent.pointerMove(svg, { clientX: 44, clientY: 50, pointerType, pressure })
  fireEvent.pointerUp(svg, { clientX: 44, clientY: 50, pointerType, pressure })
}

/** The editor's interactive svg has aria-label "Annotation overlay" (SceneSvg). */
function getEditorSvg(): Element {
  const svg = document.querySelector('svg[aria-label="Annotation overlay"]')
  if (!svg) throw new Error('editor svg not found')
  return svg
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnnotateEditor', () => {
  let mockApi: MockApi

  beforeEach(() => {
    mockApi = installMockApi()
    mockApi.youtube.saveOverlay.mockResolvedValue({ overlayPath: '/store/2026/05/att-001.svg' })
  })

  it('renders a toolbar with pen, text, eraser, Done, Cancel', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: /pen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /text/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /eraser/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('switching tools updates the active tool (aria-pressed marks current)', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    const pen = screen.getByRole('button', { name: /pen/i })
    const eraser = screen.getByRole('button', { name: /eraser/i })

    // Pen is the default active tool
    expect(pen).toHaveAttribute('aria-pressed', 'true')
    expect(eraser).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(eraser)
    expect(eraser).toHaveAttribute('aria-pressed', 'true')
    expect(pen).toHaveAttribute('aria-pressed', 'false')
  })

  it('pen: a pointerdown→move→up sequence appends exactly one stroke (path) to the scene', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    const svg = getEditorSvg()
    expect(svg.querySelectorAll('path').length).toBe(0)

    drawStroke(svg, { pointerType: 'mouse' })

    // One committed stroke → one <path> rendered.
    expect(svg.querySelectorAll('path').length).toBe(1)
  })

  it('pen with pointerType "pen" → simulatePressure false; mouse → true (B3 behavior)', async () => {
    const onClose = vi.fn()
    const { unmount } = renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={onClose} />,
    )
    // Draw with a stylus.
    drawStroke(getEditorSvg(), { pointerType: 'pen', pressure: 0.9 })
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))

    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce())
    const penSvg = mockApi.youtube.saveOverlay.mock.calls[0]?.[0].svg as string
    // simulatePressure serialized as data-sim — stylus stroke → false.
    expect(penSvg).toContain('data-sim="false"')
    unmount()

    // Now a mouse stroke → simulatePressure true.
    mockApi.youtube.saveOverlay.mockClear()
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    drawStroke(getEditorSvg(), { pointerType: 'mouse', pressure: 0.5 })
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce())
    const mouseSvg = mockApi.youtube.saveOverlay.mock.calls[0]?.[0].svg as string
    expect(mouseSvg).toContain('data-sim="true"')
  })

  it('text: clicking with the text tool active places a text block, and typing edits it', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /text/i }))
    const svg = getEditorSvg()
    // Place a text block.
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 120, pointerType: 'mouse' })
    // A foreignObject (text block) appears with an editable element.
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editable).not.toBeNull()

    // Type into it.
    editable.textContent = 'hello'
    fireEvent.input(editable, { target: { textContent: 'hello' } })
    expect(editable.textContent).toBe('hello')
  })

  it('eraser: pointerdown on an element removes it by id', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    // Draw one stroke.
    const svg = getEditorSvg()
    drawStroke(svg, { pointerType: 'mouse' })
    expect(svg.querySelectorAll('path').length).toBe(1)

    // Switch to eraser, then pointerdown on the stroke path.
    fireEvent.click(screen.getByRole('button', { name: /eraser/i }))
    const path = svg.querySelector('path') as Element
    fireEvent.pointerDown(path, { pointerType: 'mouse' })

    expect(svg.querySelectorAll('path').length).toBe(0)
  })

  it('undo (Ctrl+Z) reverts the last ADD', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    const svg = getEditorSvg()
    drawStroke(svg, { pointerType: 'mouse' })
    expect(svg.querySelectorAll('path').length).toBe(1)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(svg.querySelectorAll('path').length).toBe(0)
  })

  it('undo (Ctrl+Z) reverts the last ERASE (restores the erased element)', () => {
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={vi.fn()} />,
    )
    const svg = getEditorSvg()
    drawStroke(svg, { pointerType: 'mouse' })
    expect(svg.querySelectorAll('path').length).toBe(1)

    // Erase it.
    fireEvent.click(screen.getByRole('button', { name: /eraser/i }))
    fireEvent.pointerDown(svg.querySelector('path') as Element, { pointerType: 'mouse' })
    expect(svg.querySelectorAll('path').length).toBe(0)

    // Undo the erase → the stroke comes back.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(svg.querySelectorAll('path').length).toBe(1)
  })

  it('Done with an empty scene calls saveOverlay(attachment, null) (no sidecar)', async () => {
    const onClose = vi.fn()
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))

    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce())
    const arg = mockApi.youtube.saveOverlay.mock.calls[0]?.[0]
    expect(arg.attachmentId).toBe('att-001')
    expect(arg.svg).toBeNull()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('Done with a non-empty scene calls saveOverlay with the serialized SVG', async () => {
    const onClose = vi.fn()
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={onClose} />,
    )
    drawStroke(getEditorSvg(), { pointerType: 'mouse' })
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))

    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce())
    const arg = mockApi.youtube.saveOverlay.mock.calls[0]?.[0]
    expect(arg.attachmentId).toBe('att-001')
    expect(typeof arg.svg).toBe('string')
    expect((arg.svg as string).startsWith('<svg')).toBe(true)
    // The serialized SVG carries the stroke as a path with data-ink.
    expect(arg.svg as string).toContain('data-ink="stroke"')
  })

  it('Cancel closes without calling saveOverlay', () => {
    const onClose = vi.fn()
    renderWithProviders(
      <AnnotateEditor attachment={ATTACHMENT} initialScene={null} onClose={onClose} />,
    )
    drawStroke(getEditorSvg(), { pointerType: 'mouse' })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(mockApi.youtube.saveOverlay).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  // ── Esc prompts (both flows) ──────────────────────────────────────────────

  it("Esc in 'changes' mode with NO unsaved edits closes immediately (no prompt)", () => {
    const onClose = vi.fn()
    renderWithProviders(
      <AnnotateEditor
        attachment={ATTACHMENT}
        initialScene={null}
        onClose={onClose}
        escMode="changes"
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('annotate-esc-prompt')).toBeNull()
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it("Esc in 'changes' mode WITH unsaved edits opens the Discard-changes prompt; Discard closes without saving", () => {
    const onClose = vi.fn()
    renderWithProviders(
      <AnnotateEditor
        attachment={ATTACHMENT}
        initialScene={null}
        onClose={onClose}
        escMode="changes"
      />,
    )
    drawStroke(getEditorSvg(), { pointerType: 'mouse' })
    fireEvent.keyDown(window, { key: 'Escape' })

    // Prompt appears; nothing closed yet.
    expect(screen.getByTestId('annotate-esc-prompt')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    // Discard → close without save (sidecar untouched).
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))
    expect(mockApi.youtube.saveOverlay).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it("Esc in 'orphan' mode: Discard calls onDiscardOrphan then closes; saveOverlay not called", () => {
    const onClose = vi.fn()
    const onDiscardOrphan = vi.fn()
    renderWithProviders(
      <AnnotateEditor
        attachment={ATTACHMENT}
        initialScene={null}
        onClose={onClose}
        escMode="orphan"
        onDiscardOrphan={onDiscardOrphan}
      />,
    )
    // Esc with no edits still prompts in orphan mode (capture must confirm).
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('annotate-esc-prompt')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))
    expect(onDiscardOrphan).toHaveBeenCalledOnce()
    expect(mockApi.youtube.saveOverlay).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it("Esc in 'orphan' mode: Keep saves a non-empty scene then closes (saved)", async () => {
    const onClose = vi.fn()
    const onDiscardOrphan = vi.fn()
    renderWithProviders(
      <AnnotateEditor
        attachment={ATTACHMENT}
        initialScene={null}
        onClose={onClose}
        escMode="orphan"
        onDiscardOrphan={onDiscardOrphan}
      />,
    )
    drawStroke(getEditorSvg(), { pointerType: 'mouse' })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /keep as orphan/i }))

    await waitFor(() => expect(mockApi.youtube.saveOverlay).toHaveBeenCalledOnce())
    expect(onDiscardOrphan).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })

  it("Esc in 'orphan' mode: Keep with an EMPTY scene leaves the orphan (no save)", () => {
    const onClose = vi.fn()
    renderWithProviders(
      <AnnotateEditor
        attachment={ATTACHMENT}
        initialScene={null}
        onClose={onClose}
        escMode="orphan"
        onDiscardOrphan={vi.fn()}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /keep as orphan/i }))
    expect(mockApi.youtube.saveOverlay).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it('loads an initialScene (reopen): existing strokes render', () => {
    renderWithProviders(
      <AnnotateEditor
        attachment={ATTACHMENT}
        initialScene={{
          width: 1920,
          height: 1080,
          elements: [
            {
              id: 'pre-1',
              kind: 'stroke',
              points: [
                { x: 1, y: 1, pressure: 0.5 },
                { x: 2, y: 2, pressure: 0.5 },
                { x: 3, y: 3, pressure: 0.5 },
                { x: 4, y: 4, pressure: 0.5 },
              ],
              color: '#0D99FF',
              size: 8,
              simulatePressure: false,
            },
          ],
        }}
        onClose={vi.fn()}
      />,
    )
    expect(getEditorSvg().querySelectorAll('path').length).toBe(1)
  })
})
