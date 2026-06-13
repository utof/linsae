/**
 * Component tests for DevToolsHud.
 *
 * Runs in happy-dom (global default — provides localStorage + DOM).
 * Each test starts from a clean store state via `localStorage.clear()` and
 * `setOverlay('reveal', false)` so the store reads its DEFAULTS map
 * (fps=true, boot=false, wave=false, reveal=false).
 *
 * Open-trigger approach: uses `defaultOpen` prop rather than firing
 * `mod+shift+d` via fireEvent. react-hotkeys-hook v5 attaches its listener to
 * the real document; happy-dom's `mod` resolution is platform-dependent and
 * proved flaky in this repo (no prior test drives a global useHotkeys hotkey).
 * `defaultOpen` is a documented test affordance on the component.
 * @see src/renderer/src/dev/DevToolsHud.tsx
 * @see src/renderer/src/dev/devOverlays.ts
 */
import { act, fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import { DevToolsHud } from './DevToolsHud'
import { getOverlay, setOverlay } from './devOverlays'

// Reset store + DOM state before each test.
// localStorage.clear() causes getOverlay() to fall back to DEFAULTS.
// Also reset ephemeral 'reveal' via public API.
beforeEach(() => {
  localStorage.clear()
  setOverlay('reveal', false)
  installMockApi()
})

describe('DevToolsHud — closed by default', () => {
  it('panel is NOT in the document when rendered without defaultOpen', () => {
    renderWithProviders(<DevToolsHud />)
    expect(screen.queryByTestId('dev-tools-hud')).toBeNull()
  })
})

describe('DevToolsHud — opens via defaultOpen prop', () => {
  it('panel IS in the document when rendered with defaultOpen', () => {
    renderWithProviders(<DevToolsHud defaultOpen />)
    expect(screen.getByTestId('dev-tools-hud')).toBeTruthy()
  })
})

describe('DevToolsHud — one row per overlay key', () => {
  it('renders 6 checkboxes when open (4 overlays + 2 LOD toggles)', () => {
    // 4 overlay toggles (fps/boot/wave/reveal) + the LOD section's
    // "unclamp zoom" + "synthetic 10k dots" checkboxes (Task 8 Step 2).
    renderWithProviders(<DevToolsHud defaultOpen />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(6)
  })

  it('renders the LOD section: force-tier buttons + its two toggles', () => {
    renderWithProviders(<DevToolsHud defaultOpen />)
    // Three force-tier buttons (auto/card/dot).
    expect(screen.getByRole('button', { name: 'auto' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'card' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'dot' })).toBeTruthy()
    // Its two checkboxes' labels.
    expect(screen.getByText(/unclamp zoom/i)).toBeTruthy()
    expect(screen.getByText(/synthetic 10k dots/i)).toBeTruthy()
  })

  it('renders all four overlay labels', () => {
    renderWithProviders(<DevToolsHud defaultOpen />)
    // Labels are rendered inside Row's <span> (COL.dim) and correspond to
    // the OVERLAYS constant in DevToolsHud.tsx.
    expect(screen.getByText(/FPS meter/i)).toBeTruthy()
    expect(screen.getByText(/Boot meter/i)).toBeTruthy()
    expect(screen.getByText(/Wave tuner/i)).toBeTruthy()
    expect(screen.getByText(/Reveal playground/i)).toBeTruthy()
  })
})

describe('DevToolsHud — checkbox reflects store state', () => {
  it('Wave checkbox is checked when store has wave=true', () => {
    act(() => setOverlay('wave', true))
    renderWithProviders(<DevToolsHud defaultOpen />)
    // Row label is "Wave tuner" — find the checkbox in its sibling cell.
    // getAllByRole('checkbox') order follows OVERLAYS: fps, boot, wave, reveal
    const checkboxes = screen.getAllByRole('checkbox')
    // index 2 = wave (0=fps, 1=boot, 2=wave, 3=reveal)
    expect((checkboxes[2] as HTMLInputElement).checked).toBe(true)
  })

  it('FPS checkbox is checked by default (store default fps=true)', () => {
    // fps defaults to true per DEFAULTS in devOverlays.ts
    renderWithProviders(<DevToolsHud defaultOpen />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
  })

  it('Boot checkbox is unchecked by default (store default boot=false)', () => {
    renderWithProviders(<DevToolsHud defaultOpen />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false)
  })
})

describe('DevToolsHud — clicking toggles store', () => {
  it('clicking Boot checkbox flips store to true', () => {
    renderWithProviders(<DevToolsHud defaultOpen />)
    const checkboxes = screen.getAllByRole('checkbox')
    // boot defaults to false; clicking should toggle it to true
    act(() => {
      fireEvent.click(checkboxes[1]!) // index 1 = boot; always exists (4 overlays)
    })
    expect(getOverlay('boot')).toBe(true)
  })

  it('clicking Wave checkbox (already true) flips store back to false', () => {
    act(() => setOverlay('wave', true))
    renderWithProviders(<DevToolsHud defaultOpen />)
    const checkboxes = screen.getAllByRole('checkbox')
    act(() => {
      fireEvent.click(checkboxes[2]!) // index 2 = wave; always exists (4 overlays)
    })
    expect(getOverlay('wave')).toBe(false)
  })
})
