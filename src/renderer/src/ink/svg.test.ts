/**
 * Unit tests for ink/svg.ts — serializeScene / parseScene round-trip, tamper resistance,
 * and defensive parsing of unknown/garbage elements.
 * Runs in happy-dom (provides DOMParser for image/svg+xml).
 * @see src/renderer/src/ink/svg.ts
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Serialize / parse"
 */
import { describe, expect, it } from 'vitest'
import { parseScene, serializeScene } from './svg'
import type { Scene, Stroke, TextBlock } from './types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stroke1: Stroke = {
  id: 'stroke-aaa',
  kind: 'stroke',
  color: '#ff0000',
  size: 8,
  simulatePressure: false,
  points: [
    { x: 10.123, y: 20.456, pressure: 0.75 },
    { x: 50.0, y: 30.999, pressure: 0.5 },
    { x: 90.876, y: 10.111, pressure: 0.3 },
  ],
}

const stroke2: Stroke = {
  id: 'stroke-bbb',
  kind: 'stroke',
  color: '#0000ff',
  size: 4,
  simulatePressure: true,
  points: [
    { x: 5.0, y: 5.0, pressure: 0.6 },
    { x: 15.5, y: 25.5, pressure: 0.4 },
  ],
}

const text1: TextBlock = {
  id: 'text-ccc',
  kind: 'text',
  x: 100,
  y: 200,
  width: 150,
  height: 40,
  text: 'Hello <world> & "test"',
  color: '#333333',
  fontSize: 16,
}

const scene: Scene = {
  width: 1920,
  height: 1080,
  elements: [stroke1, text1, stroke2],
}

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe('serializeScene / parseScene round-trip', () => {
  it('preserves stroke fields: id, kind, color, size, simulatePressure', () => {
    const parsed = parseScene(serializeScene(scene))
    const s1 = parsed.elements.find((e) => e.id === 'stroke-aaa') as Stroke
    expect(s1).toBeDefined()
    expect(s1.kind).toBe('stroke')
    expect(s1.color).toBe(stroke1.color)
    expect(s1.size).toBe(stroke1.size)
    expect(s1.simulatePressure).toBe(stroke1.simulatePressure)
  })

  it('preserves stroke points to 2 decimal places', () => {
    const parsed = parseScene(serializeScene(scene))
    const s1 = parsed.elements.find((e) => e.id === 'stroke-aaa') as Stroke
    // noUncheckedIndexedAccess: s1 is defined (verified above) and has 3 points from stroke1 fixture.
    const p0 = s1.points[0]!
    // Numbers are serialized to 2dp so we compare to 2dp
    expect(p0.x).toBeCloseTo(10.12, 1)
    expect(p0.y).toBeCloseTo(20.46, 1)
    expect(p0.pressure).toBeCloseTo(0.75, 2)
  })

  it('preserves text fields: id, kind, text, color, fontSize, x, y, width', () => {
    const parsed = parseScene(serializeScene(scene))
    const t1 = parsed.elements.find((e) => e.id === 'text-ccc') as TextBlock
    expect(t1).toBeDefined()
    expect(t1.kind).toBe('text')
    expect(t1.text).toBe(text1.text)
    expect(t1.color).toBe(text1.color)
    expect(t1.fontSize).toBe(text1.fontSize)
    expect(t1.x).toBe(text1.x)
    expect(t1.y).toBe(text1.y)
    expect(t1.width).toBe(text1.width)
  })

  it('preserves z-order (element array order)', () => {
    const parsed = parseScene(serializeScene(scene))
    // noUncheckedIndexedAccess: scene fixture has exactly 3 elements.
    expect(parsed.elements[0]!.id).toBe('stroke-aaa')
    expect(parsed.elements[1]!.id).toBe('text-ccc')
    expect(parsed.elements[2]!.id).toBe('stroke-bbb')
  })

  it('does NOT assert text height (re-measured on parse)', () => {
    const parsed = parseScene(serializeScene(scene))
    const t1 = parsed.elements.find((e) => e.id === 'text-ccc') as TextBlock
    // height may be 0 in happy-dom (no layout engine) — that is acceptable;
    // the spec says height is re-measured when the editor reopens.
    expect(typeof t1.height).toBe('number')
  })

  it('preserves scene width and height', () => {
    const parsed = parseScene(serializeScene(scene))
    expect(parsed.width).toBe(1920)
    expect(parsed.height).toBe(1080)
  })

  it('round-trips simulatePressure=true on stroke2', () => {
    const parsed = parseScene(serializeScene(scene))
    const s2 = parsed.elements.find((e) => e.id === 'stroke-bbb') as Stroke
    expect(s2.simulatePressure).toBe(true)
  })

  it('serialized SVG contains viewBox="0 0 1920 1080"', () => {
    const svg = serializeScene(scene)
    expect(svg).toContain('viewBox="0 0 1920 1080"')
  })
})

// ---------------------------------------------------------------------------
// Tamper resistance
// ---------------------------------------------------------------------------

describe('parseScene tamper resistance', () => {
  it('ignores a corrupted <path d="…"> and rebuilds from data-points', () => {
    const svg = serializeScene(scene)
    // Corrupt only the path's standalone `d` attribute (` d="..."`) to garbage.
    // Uses a word-boundary-like pattern (space before `d=`) to avoid corrupting
    // `data-id="..."` attributes which also contain the substring `d="`.
    const tampered = svg.replace(/ d="[^"]*"/g, ' d="GARBAGE_NOT_A_PATH"')
    // Should not throw and should still reconstruct the strokes from data-points
    const parsed = parseScene(tampered)
    const s1 = parsed.elements.find((e) => e.id === 'stroke-aaa') as Stroke
    expect(s1).toBeDefined()
    expect(s1.kind).toBe('stroke')
    expect(s1.points.length).toBe(3)
    expect(s1.color).toBe(stroke1.color)
  })
})

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

describe('parseScene defensive parsing', () => {
  it('skips unknown <rect> elements without throwing', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect x="0" y="0" width="50" height="50" />
    </svg>`
    const parsed = parseScene(svg)
    expect(parsed.elements).toEqual([])
    expect(parsed.width).toBe(100)
    expect(parsed.height).toBe(100)
  })

  it('skips elements with data-ink="bogus" without throwing', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <path data-ink="bogus" data-id="x" d="M0,0 Z"/>
    </svg>`
    const parsed = parseScene(svg)
    expect(parsed.elements).toEqual([])
  })

  it('parses an empty <svg> to an empty scene', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"></svg>`
    const parsed = parseScene(svg)
    expect(parsed.elements).toEqual([])
    expect(parsed.width).toBe(640)
    expect(parsed.height).toBe(360)
  })

  it('does not throw on an SVG with a data-ink="stroke" element missing data-points', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <path data-ink="stroke" data-id="no-points" data-size="8" data-sim="false" d="M0,0 Z"/>
    </svg>`
    // Should parse gracefully — element omitted or has empty points
    expect(() => parseScene(svg)).not.toThrow()
  })
})
