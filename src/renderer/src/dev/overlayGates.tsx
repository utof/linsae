import { DevBootMeter } from '../components/DevBootMeter'
import { DevFpsMeter } from '../components/DevFpsMeter'
import { useDevOverlay } from './devOverlays'

/**
 * Mounts {@link DevFpsMeter} only when the `fps` overlay is on.
 * @see ./devOverlays
 */
export function FpsMeterGate(): React.JSX.Element | null {
  return useDevOverlay('fps') ? <DevFpsMeter /> : null
}

/**
 * Mounts {@link DevBootMeter} only when the `boot` overlay is on.
 * Must be rendered inside QueryClientProvider (the meter reads the ['notes'] query).
 * @see ./devOverlays
 */
export function BootMeterGate(): React.JSX.Element | null {
  return useDevOverlay('boot') ? <DevBootMeter /> : null
}
