// @vitest-environment happy-dom
/**
 * Component tests for AnnotatedFrame.
 *
 * - Renders base <img> from mediaUrlFromPath(base_path).
 * - When overlay_path set and scene loaded: also renders an inert <SceneSvg>.
 * - onReopen supplied → pencil button (data-testid="annotated-frame-reopen") is
 *   present in DOM and calls onReopen on click.
 * - onReopen omitted → no pencil button.
 *
 * @see src/renderer/src/annotate/AnnotatedFrame.tsx
 * @see docs/specs/v0.2.5-screenshot-annotation.md §AnnotatedFrame
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import type { Attachment } from '../../../shared/types'
import { serializeScene } from '../ink/svg'
import { AnnotatedFrame } from './AnnotatedFrame'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATTACHMENT_NO_OVERLAY: Attachment = {
  id: 'att-001',
  note_id: 'note-001',
  kind: 'screenshot',
  base_sha256: 'abcdef',
  base_path: '/store/2026/05/abcdef.png',
  overlay_path: null,
  video_id: 'vid1',
  time_seconds: 42,
  width_px: 1920,
  height_px: 1080,
  device_pixel_ratio: 2,
  created_at: 1000,
  deleted_at: null,
}

const ATTACHMENT_WITH_OVERLAY: Attachment = {
  ...ATTACHMENT_NO_OVERLAY,
  overlay_path: '/store/2026/05/att-001.svg',
}

// An SVG that parses to a valid scene (width/height extracted from viewBox)
const VALID_SVG = serializeScene({ width: 1920, height: 1080, elements: [] })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnnotatedFrame', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('renders the base img with the correct /_media src', () => {
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_NO_OVERLAY} />)
    const img = screen.getByRole('img', { name: /captured frame/i })
    expect(img.getAttribute('src')).toBe('/_media/2026/05/abcdef.png')
  })

  it('does NOT render the SceneSvg when overlay_path is null', () => {
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_NO_OVERLAY} />)
    // SceneSvg renders an <svg> element; with no overlay there should be none
    expect(document.querySelector('svg')).toBeNull()
  })

  it('renders the inert SceneSvg over the base img when overlay_path is set and scene is loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VALID_SVG, { status: 200 }))
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_WITH_OVERLAY} />)

    // The base img must always be present
    expect(screen.getByRole('img', { name: /captured frame/i })).toBeInTheDocument()

    // Wait for the async overlay fetch to complete and SceneSvg to render
    await waitFor(() => {
      expect(document.querySelector('svg')).not.toBeNull()
    })

    // The svg must be inert (pointer-events:none) — no handlers supplied to SceneSvg
    const svg = document.querySelector('svg') as SVGElement
    expect(svg.style.pointerEvents).toBe('none')
  })

  it('does NOT render SceneSvg while overlay is loading (no flash of broken state)', () => {
    // fetch never resolves during this check
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_WITH_OVERLAY} />)
    // During loading, no svg yet
    expect(document.querySelector('svg')).toBeNull()
  })

  it('onReopen omitted → no pencil button rendered', () => {
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_NO_OVERLAY} />)
    expect(screen.queryByTestId('annotated-frame-reopen')).toBeNull()
  })

  it('onReopen supplied → pencil button is present in DOM and calls onReopen on click', () => {
    const onReopen = vi.fn()
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_NO_OVERLAY} onReopen={onReopen} />)
    const btn = screen.getByTestId('annotated-frame-reopen')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onReopen).toHaveBeenCalledOnce()
  })

  // BLOCKER 2 regression: overlay_path set but body unparseable → useOverlayScene
  // maps the garbage sentinel {0,0,[]} to null, so NO SceneSvg renders.
  it('does NOT render SceneSvg when overlay_path is set but the body is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('this is not svg at all !!', { status: 200 }),
    )
    const { container } = renderWithProviders(
      <AnnotatedFrame attachment={ATTACHMENT_WITH_OVERLAY} />,
    )

    // The base img still renders
    expect(screen.getByRole('img', { name: /captured frame/i })).toBeInTheDocument()

    // Give the async query a chance to settle; the overlay must remain absent.
    await waitFor(() => {
      // querySelector for an <svg> child of the frame container — none should appear
      expect(container.querySelector('svg')).toBeNull()
    })
  })

  // IMPORTANT regression: hover-reveal is driven by CONTAINER hover, not the
  // button itself (a button-only listener never fires while opacity:0).
  it('reveals the pencil button on container hover and hides it on leave', () => {
    const onReopen = vi.fn()
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_NO_OVERLAY} onReopen={onReopen} />)
    const btn = screen.getByTestId('annotated-frame-reopen') as HTMLButtonElement
    // The container is the button's positioned ancestor (the frame div).
    const containerEl = btn.parentElement as HTMLElement

    // At rest the button is hidden.
    expect(btn.style.opacity).toBe('0')

    // Hovering the CONTAINER reveals it.
    fireEvent.mouseEnter(containerEl)
    expect(btn.style.opacity).toBe('1')

    // Leaving the container hides it again.
    fireEvent.mouseLeave(containerEl)
    expect(btn.style.opacity).toBe('0')
  })

  it('reveals the pencil button on keyboard focus (a11y)', () => {
    const onReopen = vi.fn()
    renderWithProviders(<AnnotatedFrame attachment={ATTACHMENT_NO_OVERLAY} onReopen={onReopen} />)
    const btn = screen.getByTestId('annotated-frame-reopen') as HTMLButtonElement
    expect(btn.style.opacity).toBe('0')
    fireEvent.focus(btn)
    expect(btn.style.opacity).toBe('1')
    fireEvent.blur(btn)
    expect(btn.style.opacity).toBe('0')
  })
})
