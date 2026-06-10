/**
 * Component tests for FpsMeterGate and BootMeterGate.
 *
 * Runs in happy-dom (global default — provides localStorage + DOM).
 * Each test starts from fresh localStorage defaults via `localStorage.clear()`
 * so the store reads its DEFAULTS map (fps=true, boot=false).
 *
 * Assertion targets:
 *   - FpsMeterGate / DevFpsMeter: presence of a <canvas> element (the fps sparkline).
 *     DevFpsMeter renders exactly one <canvas ref={canvasRef}> at its root.
 *     @see src/renderer/src/components/DevFpsMeter.tsx:111
 *   - BootMeterGate / DevBootMeter: presence of a <div aria-hidden> child at
 *     container.firstElementChild. When the gate returns null the container is empty
 *     (container.childElementCount === 0).
 *     @see src/renderer/src/components/DevBootMeter.tsx:83
 *
 * @see src/renderer/src/dev/overlayGates.tsx
 * @see src/renderer/src/dev/devOverlays.ts
 */
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, renderWithProviders } from '../../../../tests/setup'
import { setOverlay } from './devOverlays'
import { BootMeterGate, FpsMeterGate } from './overlayGates'

// Reset store + DOM state before each test. localStorage.clear() causes
// getOverlay() to fall back to DEFAULTS (fps=true, boot=false).
// Also reset ephemeral 'reveal' via public API (belt-and-suspenders).
beforeEach(() => {
  localStorage.clear()
  setOverlay('reveal', false)
})

describe('FpsMeterGate', () => {
  it('renders DevFpsMeter (canvas present) when fps overlay is on (default true)', () => {
    // fps defaults to true — no explicit setOverlay needed
    const { container } = renderWithProviders(<FpsMeterGate />)
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('renders nothing (canvas absent) after setOverlay("fps", false)', () => {
    act(() => setOverlay('fps', false))
    const { container } = renderWithProviders(<FpsMeterGate />)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('re-renders to null when fps toggled off after initial mount', () => {
    const { container } = renderWithProviders(<FpsMeterGate />)
    // Initially on — canvas present
    expect(container.querySelector('canvas')).not.toBeNull()
    act(() => setOverlay('fps', false))
    // After toggle — canvas gone
    expect(container.querySelector('canvas')).toBeNull()
  })
})

describe('BootMeterGate', () => {
  beforeEach(() => {
    // DevBootMeter calls useQuery(['notes']) + window.api.notes.list()
    installMockApi()
  })

  it('renders nothing (container empty) when boot overlay is off (default false)', () => {
    // boot defaults to false — no explicit setOverlay needed
    const { container } = renderWithProviders(<BootMeterGate />)
    expect(container.childElementCount).toBe(0)
  })

  it('renders DevBootMeter (container non-empty) after setOverlay("boot", true)', () => {
    act(() => setOverlay('boot', true))
    const { container } = renderWithProviders(<BootMeterGate />)
    expect(container.childElementCount).toBeGreaterThan(0)
  })

  it('re-renders to show meter when boot toggled on after initial mount', () => {
    const { container } = renderWithProviders(<BootMeterGate />)
    // Initially off — nothing rendered
    expect(container.childElementCount).toBe(0)
    act(() => setOverlay('boot', true))
    // After toggle — meter mounted
    expect(container.childElementCount).toBeGreaterThan(0)
  })
})
