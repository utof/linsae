import { describe, expect, it } from 'vitest'
import {
  clearMeasurement,
  getCachedHeight,
  getMeasurementTick,
  recordMeasurement,
  subscribeMeasurements,
} from './measurementCache'

describe('measurementCache', () => {
  it('coalesces a burst of synchronous record calls into one notification', async () => {
    let notifyCount = 0
    const unsubscribe = subscribeMeasurements(() => {
      notifyCount++
    })

    // Reproduces the cascade that caused the depth-exceeded crash: many
    // bubbles' ResizeObservers firing initial measurements back-to-back as
    // Virtuoso mounts a stream of new items during a scroll. Without
    // microtask batching this would notify N times → N forced re-renders →
    // depth-limit crash.
    for (let i = 0; i < 20; i++) {
      recordMeasurement(`note-${i}`, 60 + i)
    }

    // Notifications are deferred to a microtask — none should have fired yet.
    expect(notifyCount).toBe(0)
    // But the cache itself was written synchronously, so the next render
    // sees the full updated state.
    expect(getCachedHeight('note-0')).toBe(60)
    expect(getCachedHeight('note-19')).toBe(79)

    // Yield once to let the queued microtask run.
    await Promise.resolve()

    expect(notifyCount).toBe(1)

    unsubscribe()
    for (let i = 0; i < 20; i++) clearMeasurement(`note-${i}`)
    await Promise.resolve()
  })

  it('schedules a fresh notification for the next burst', async () => {
    let notifyCount = 0
    const unsubscribe = subscribeMeasurements(() => {
      notifyCount++
    })

    recordMeasurement('a', 100)
    await Promise.resolve()
    expect(notifyCount).toBe(1)

    recordMeasurement('b', 200)
    await Promise.resolve()
    expect(notifyCount).toBe(2)

    unsubscribe()
    clearMeasurement('a')
    clearMeasurement('b')
    await Promise.resolve()
  })

  it('bumps the tick exactly once per microtask burst', async () => {
    const startTick = getMeasurementTick()
    recordMeasurement('x', 1)
    recordMeasurement('y', 2)
    recordMeasurement('z', 3)
    // Tick is bumped inside the microtask, not synchronously.
    expect(getMeasurementTick()).toBe(startTick)
    await Promise.resolve()
    expect(getMeasurementTick()).toBe(startTick + 1)

    clearMeasurement('x')
    clearMeasurement('y')
    clearMeasurement('z')
    await Promise.resolve()
  })
})
