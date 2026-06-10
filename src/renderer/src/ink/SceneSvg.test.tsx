/**
 * Component tests for ink/SceneSvg.tsx.
 * Runs in happy-dom (global renderer env). Uses RTL.
 * @see src/renderer/src/ink/SceneSvg.tsx
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Presentational renderer"
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SceneSvg } from './SceneSvg'
import type { Scene } from './types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testScene: Scene = {
  width: 1280,
  height: 720,
  elements: [
    {
      id: 'stroke-1',
      kind: 'stroke',
      color: '#ff0000',
      size: 8,
      simulatePressure: true,
      points: [
        { x: 10, y: 10, pressure: 0.5 },
        { x: 50, y: 50, pressure: 0.7 },
        { x: 90, y: 30, pressure: 0.4 },
        { x: 100, y: 20, pressure: 0.6 },
        { x: 110, y: 10, pressure: 0.5 },
      ],
    },
    {
      id: 'stroke-2',
      kind: 'stroke',
      color: '#0000ff',
      size: 4,
      simulatePressure: false,
      points: [
        { x: 200, y: 100, pressure: 0.8 },
        { x: 220, y: 120, pressure: 0.6 },
        { x: 240, y: 100, pressure: 0.7 },
        { x: 260, y: 80, pressure: 0.5 },
        { x: 280, y: 100, pressure: 0.6 },
      ],
    },
    {
      id: 'text-1',
      kind: 'text',
      x: 100,
      y: 200,
      width: 200,
      height: 40,
      text: 'Hello world',
      color: '#333333',
      fontSize: 16,
    },
  ],
}

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe('SceneSvg — rendering', () => {
  it('renders one <path> per stroke element', () => {
    const { container } = render(<SceneSvg scene={testScene} />)
    const paths = container.querySelectorAll('path')
    expect(paths.length).toBe(2)
  })

  it('renders one <foreignObject> per text element', () => {
    const { container } = render(<SceneSvg scene={testScene} />)
    const fos = container.querySelectorAll('foreignObject')
    expect(fos.length).toBe(1)
  })

  it('sets viewBox to "0 0 {width} {height}"', () => {
    const { container } = render(<SceneSvg scene={testScene} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 1280 720')
  })

  it('sets preserveAspectRatio="xMidYMid meet"', () => {
    const { container } = render(<SceneSvg scene={testScene} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
  })
})

// ---------------------------------------------------------------------------
// Inert mode (no handlers)
// ---------------------------------------------------------------------------

describe('SceneSvg — inert mode (no handlers supplied)', () => {
  it('sets pointer-events:none on the root <svg> when no handlers supplied', () => {
    const { container } = render(<SceneSvg scene={testScene} />)
    const svg = container.querySelector('svg')
    // React sets inline style as camelCase; check the style attribute or property
    expect(svg?.style.pointerEvents).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// Interactive mode (with handlers)
// ---------------------------------------------------------------------------

describe('SceneSvg — interactive mode (with handlers)', () => {
  it('does NOT set pointer-events:none when onElementPointerDown is supplied', () => {
    const handler = vi.fn()
    const { container } = render(<SceneSvg scene={testScene} onElementPointerDown={handler} />)
    const svg = container.querySelector('svg')
    expect(svg?.style.pointerEvents).not.toBe('none')
  })

  it('calls onElementPointerDown with the element id when a path is pointer-downed', () => {
    const handler = vi.fn()
    const { container } = render(<SceneSvg scene={testScene} onElementPointerDown={handler} />)
    const paths = container.querySelectorAll('path')
    // Fire pointerdown on the first path (stroke-1).
    // noUncheckedIndexedAccess: scene has 2 strokes so paths[0] exists.
    fireEvent.pointerDown(paths[0]!)
    expect(handler).toHaveBeenCalledWith('stroke-1', expect.anything())
  })

  it('calls onElementPointerDown with correct id for second stroke', () => {
    const handler = vi.fn()
    const { container } = render(<SceneSvg scene={testScene} onElementPointerDown={handler} />)
    const paths = container.querySelectorAll('path')
    // noUncheckedIndexedAccess: scene has 2 strokes so paths[1] exists.
    fireEvent.pointerDown(paths[1]!)
    expect(handler).toHaveBeenCalledWith('stroke-2', expect.anything())
  })
})
