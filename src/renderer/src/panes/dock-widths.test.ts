// src/renderer/src/panes/dock-widths.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clampWidth, DOCK_WIDTH, defaultWidthFor } from './dock-widths'

describe('dock-widths', () => {
  it('clamps to the utility band (220–400)', () => {
    expect(clampWidth('utility', 100)).toBe(220)
    expect(clampWidth('utility', 300)).toBe(300)
    expect(clampWidth('utility', 999)).toBe(400)
  })
  it('clamps to the content band (400–900)', () => {
    expect(clampWidth('content', 100)).toBe(400)
    expect(clampWidth('content', 600)).toBe(600)
    expect(clampWidth('content', 9999)).toBe(900)
  })
  it('defaults: utility 280, content 600', () => {
    expect(defaultWidthFor('utility')).toBe(280)
    expect(defaultWidthFor('content')).toBe(600)
    expect(DOCK_WIDTH.content.max).toBe(900)
  })
})
