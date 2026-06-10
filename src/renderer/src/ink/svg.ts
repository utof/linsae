/**
 * Serialize and parse a `Scene` to/from a standalone SVG string.
 *
 * **Serialize** writes both the rendered outline (`d`) for standalone viewing AND
 * `data-points` (raw input) for re-editability. The `d` is intentionally ignored on
 * parse — only `data-*` attributes are read back, forming the XSS boundary: stored
 * markup is never injected.
 *
 * **Parse** is defensive: unknown elements and invalid attribute values are silently
 * skipped; the function never throws on malformed input.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Serialize / parse"
 * @see adrs/0025-drawing-overlay-format.md
 * @see adrs/0026-overlay-render-inline-svg.md
 */
import { strokeToPath } from './stroke'
import type { InkPoint, Scene, SceneElement, Stroke, TextBlock } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats a number to at most 2 decimal places (no trailing zeros).
 * Why: keeps the SVG file compact and ensures the round-trip precision spec
 * ("numbers to 2-dp") is met.
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Serialize / parse"
 */
function fmt(n: number): string {
  return Number(n.toFixed(2)).toString()
}

/**
 * Encodes text content for inline SVG/HTML use.
 * Escapes the five XML special characters so the serialized SVG is valid XML and
 * the div text inside foreignObject renders correctly.
 * Why: textContent in SVG must not contain raw `<`, `>`, `&`, `"`, `'`.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ---------------------------------------------------------------------------
// serializeScene
// ---------------------------------------------------------------------------

/**
 * Converts a `Scene` into a standalone, raw-viewable SVG string.
 *
 * - One `<path>` per `Stroke`: carries both the rendered outline `d` (for standalone
 *   viewing) and `data-points` (raw input, the re-editable source of truth).
 * - One `<foreignObject>` per `TextBlock`: `height` is the serialized numeric value
 *   (NEVER `auto` — `auto`/invalid lengths compute to 0 on foreignObject, breaking
 *   standalone viewing).
 * - `data-points` format: `"{x},{y},{p} {x},{y},{p} …"` (space-separated triples, 2dp).
 *
 * @see adrs/0025-drawing-overlay-format.md
 */
export function serializeScene(scene: Scene): string {
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}">`,
  )

  for (const el of scene.elements) {
    if (el.kind === 'stroke') {
      const d = strokeToPath(el)
      const dataPoints = el.points
        .map((p) => `${fmt(p.x)},${fmt(p.y)},${fmt(p.pressure)}`)
        .join(' ')
      parts.push(
        `  <path d="${escapeXml(d)}" fill="${escapeXml(el.color)}"` +
          ` data-ink="stroke" data-id="${escapeXml(el.id)}"` +
          ` data-size="${fmt(el.size)}" data-sim="${el.simulatePressure}"` +
          ` data-points="${escapeXml(dataPoints)}"/>`,
      )
    } else if (el.kind === 'text') {
      // height MUST be a numeric value — auto/invalid computes to 0 on foreignObject.
      const h = Number.isFinite(el.height) && el.height > 0 ? el.height : 1
      parts.push(
        `  <foreignObject x="${fmt(el.x)}" y="${fmt(el.y)}" width="${fmt(el.width)}" height="${fmt(h)}"` +
          ` data-ink="text" data-id="${escapeXml(el.id)}"` +
          ` data-color="${escapeXml(el.color)}" data-font="${fmt(el.fontSize)}">` +
          `<div xmlns="http://www.w3.org/1999/xhtml" style="color:${el.color};font-size:${fmt(el.fontSize)}px;white-space:pre-wrap;word-break:break-word">${escapeXml(el.text)}</div>` +
          `</foreignObject>`,
      )
    }
  }

  parts.push('</svg>')
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// parseScene
// ---------------------------------------------------------------------------

/**
 * Parses a serialized SVG string back into a `Scene`.
 *
 * - Reads ONLY `data-*` attributes — the `<path d>` geometry is intentionally ignored
 *   (it will be recomputed on render). This is the XSS boundary: stored markup is never
 *   injected into the DOM.
 * - Unknown elements (no `data-ink` or `data-ink` value not in `{'stroke','text'}`) are
 *   silently skipped.
 * - Invalid / missing attribute values fall back gracefully (empty points → empty array,
 *   missing numeric → 0).
 * - Never throws on malformed input.
 *
 * `data-points` format: `"{x},{y},{p} {x},{y},{p} …"` — each triple comma-separated,
 * triples space-separated.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §"Serialize / parse"
 * @see adrs/0026-overlay-render-inline-svg.md
 */
export function parseScene(svg: string): Scene {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return { width: 0, height: 0, elements: [] }
  }

  // Check for DOMParser parse error (returns an XML error document)
  const parserError = doc.querySelector('parsererror')
  if (parserError) {
    return { width: 0, height: 0, elements: [] }
  }

  const svgEl = doc.documentElement
  // Parse viewBox to get width/height; fall back to width/height attributes
  const viewBox = svgEl.getAttribute('viewBox') ?? ''
  const vbParts = viewBox.trim().split(/\s+/)
  let width = 0
  let height = 0
  if (vbParts.length === 4) {
    // noUncheckedIndexedAccess: length===4 guard guarantees indices 2 and 3 exist.
    width = Number.parseFloat(vbParts[2]!) || 0
    height = Number.parseFloat(vbParts[3]!) || 0
  }
  if (!width) width = Number.parseFloat(svgEl.getAttribute('width') ?? '0') || 0
  if (!height) height = Number.parseFloat(svgEl.getAttribute('height') ?? '0') || 0

  const elements: SceneElement[] = []

  // Walk all direct children of the SVG root (one level — the serializer only emits
  // top-level elements, not nested ones)
  for (const child of Array.from(svgEl.children)) {
    const inkType = child.getAttribute('data-ink')
    if (!inkType) continue // no data-ink → skip

    if (inkType === 'stroke') {
      const el = parseStrokeElement(child)
      if (el) elements.push(el)
    } else if (inkType === 'text') {
      const el = parseTextElement(child)
      if (el) elements.push(el)
    }
    // else: unknown data-ink value → skip silently
  }

  return { width, height, elements }
}

// ---------------------------------------------------------------------------
// Private parsers
// ---------------------------------------------------------------------------

/**
 * Parses a `<path data-ink="stroke">` element into a `Stroke`.
 * Returns `null` on missing required attributes (id).
 * Why null-return: caller skips silently; never throws.
 */
function parseStrokeElement(el: Element): Stroke | null {
  const id = el.getAttribute('data-id')
  if (!id) return null

  const color = el.getAttribute('data-color') ?? el.getAttribute('fill') ?? '#000000'
  const size = Number.parseFloat(el.getAttribute('data-size') ?? '8') || 8
  const simAttr = el.getAttribute('data-sim')
  const simulatePressure = simAttr !== 'false' // anything other than 'false' → true

  const dataPoints = el.getAttribute('data-points') ?? ''
  const points = parseDataPoints(dataPoints)

  return { id, kind: 'stroke', color, size, simulatePressure, points }
}

/**
 * Parses a `<foreignObject data-ink="text">` element into a `TextBlock`.
 * Returns `null` on missing required attributes (id).
 * Why null-return: caller skips silently; never throws.
 */
function parseTextElement(el: Element): TextBlock | null {
  const id = el.getAttribute('data-id')
  if (!id) return null

  const color = el.getAttribute('data-color') ?? '#000000'
  const fontSize = Number.parseFloat(el.getAttribute('data-font') ?? '16') || 16
  const x = Number.parseFloat(el.getAttribute('x') ?? '0') || 0
  const y = Number.parseFloat(el.getAttribute('y') ?? '0') || 0
  const width = Number.parseFloat(el.getAttribute('width') ?? '100') || 100
  // height is read for standalone fidelity but re-measured on editor reopen
  const height = Number.parseFloat(el.getAttribute('height') ?? '0') || 0

  // Extract text content from the inner div (text was XML-escaped by the serializer;
  // the parser unescapes it automatically)
  const innerDiv = el.querySelector('div')
  const text = innerDiv?.textContent ?? ''

  return { id, kind: 'text', x, y, width, height, text, color, fontSize }
}

/**
 * Parses the `data-points` attribute value (`"{x},{y},{p} …"`) into `InkPoint[]`.
 * Returns `[]` on empty/malformed input — never throws.
 * Why: malformed data-points means no points, but the stroke element is still valid
 * (it can be erased by id even if its geometry can't be recomputed).
 */
function parseDataPoints(raw: string): InkPoint[] {
  if (!raw.trim()) return []
  const points: InkPoint[] = []
  for (const triple of raw.trim().split(' ')) {
    if (!triple) continue
    const parts = triple.split(',')
    if (parts.length !== 3) continue
    // noUncheckedIndexedAccess: parts.length === 3 guarantees indices 0-2 exist.
    const x = Number.parseFloat(parts[0]!)
    const y = Number.parseFloat(parts[1]!)
    const pressure = Number.parseFloat(parts[2]!)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pressure)) continue
    points.push({ x, y, pressure })
  }
  return points
}
