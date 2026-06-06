import { cancelFrame, frame } from 'motion'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { projectNoOverlap } from './pbdProjection'
import type { EntranceCtx } from './types'
import { springStep } from './waveSpring'

// Tuned production constants — ported from the dev spike's defaults
// (`RevealPlayground.tsx`, the values the user settled on). Re-tune later by the
// DevFpsMeter, not by feel (per the spec's perf note); they're module-level so the
// frame loop reads stable values without UI knobs.
const STAGGER_MS = 20 // per-row settle delay → the wave travels UP the stack
const STIFFNESS = 180
const DAMPING = 18
const PROJ_PASSES = 8 // Gauss-Seidel non-overlap passes (pbd only)

/** Per-row physics state. `off` = current `--wy` offset (px); `vel` = its velocity;
 *  `delay` = ms still to wait before this row starts settling (makes the wave travel up). */
type WaveState = { off: number; vel: number; delay: number }

/**
 * The shared wave entrance engine for `flip` and `pbd` — the "same-polarity magnet"
 * send animation. The newcomer rises from one note-height below its slot and shoves the
 * notes above it up in a propagating wave; `pbd` additionally enforces a hard non-overlap
 * constraint each frame, `flip` lets the stagger do it (and overlaps softly by design).
 * Both models are one engine; they differ ONLY by the per-frame projection step.
 *
 * How (ported from the proven spike `RevealPlayground.tsx`, `5ba17cc`):
 * - On a single append: pin `scrollTop = scrollHeight`, then seed an id-keyed
 *   `Map<noteId,{off,vel,delay}>` from the newcomer up at `off = +shift` (shift =
 *   newcomer `offsetHeight`, transform-immune so the size tree never sees the offset),
 *   `delay = (newIndex − idx) × STAGGER_MS`. The newcomer leads (delay 0), rising from
 *   below the fold; rows above start later, so the wave ripples upward.
 * - One Motion `frame.update(tick, true)` loop integrates each offset toward 0 with
 *   {@link springStep}, then — for `pbd` only — runs {@link projectNoOverlap} on the
 *   ordered offsets (top→bottom) and writes the result back by id, creating a resting
 *   entry for any reached row the projection pushed off 0 (so the shove can propagate to
 *   rows that weren't seeded). Each frame writes every rendered row's `--wy`, retires
 *   settled rows, and on the last retire clears the map and sets `setWaveSettling(false)`.
 *
 * Recycle-safety: state lives in a ref OUTSIDE the rows (id-keyed), and the real Feed
 * recycles DOM rows that carry only `data-index` (no `data-pw-id` — that's the spike's
 * dev-only attr). So every id lookup resolves `id = notesRef.current[index]?.id` against a
 * ref kept fresh each render — a recycled node paints the offset for whatever note now
 * occupies that index, never a stale one.
 *
 * `setWaveSettling(true)` is set at append (BEFORE the spring window) and `false` on
 * retire; the Feed reads `waveSettling` into `suppressFollow` so the virtualizer's
 * append-follow / scroll-anchor machinery stays OFF for the whole wave (the §Guard
 * finding — `reconcileScroll` would otherwise re-pin the newcomer and cancel the rise).
 *
 * No-ops (the note just appears) — mirrors the glide gates: `enabled=false` (a different
 * strategy is selected), reduced motion, no scroller, a bulk/initial load (>1 added at
 * once), a zero-height newcomer, or the user scrolled away from the bottom (`!isAtEnd`).
 *
 * @see src/renderer/src/dev/RevealPlayground.tsx (the proven engine this ports)
 * @see docs/specs/v0.2.2-repulsion-wave.md §Architecture, §The Guard
 */
export function useWaveReveal(
  ctx: EntranceCtx & { model: 'flip' | 'pbd'; enabled: boolean },
): void {
  const { virtualizer, scrollerEl, notes, setWaveSettling, model, enabled } = ctx

  // `notes` kept fresh in a ref so the tick loop + paint closures resolve a recycled row's
  // `data-index` → the note that NOW occupies that index (recycle-safe id lookup).
  const notesRef = useRef(notes)
  notesRef.current = notes
  const modelRef = useRef(model)
  modelRef.current = model

  const waveRef = useRef<Map<string, WaveState>>(new Map())
  const tickRef = useRef<((data: { delta: number }) => void) | null>(null)
  // Previous list length, to detect a single append. Initialised to the first render's
  // value so the initial mount (empty → loaded list) is never an append.
  const prevLenRef = useRef(notes.length)

  /** Rendered rows as `{ id, idx }`, sorted top→bottom (ascending virtual index). Resolves
   *  each row's note id from `notesRef` (the real Feed rows carry only `data-index`). */
  const orderedRows = useCallback((sc: HTMLElement): { id: string; idx: number }[] => {
    return Array.from(sc.querySelectorAll<HTMLElement>('[data-index]'))
      .map((el) => {
        const idx = Number(el.dataset.index)
        return { id: notesRef.current[idx]?.id ?? '', idx }
      })
      .filter((r) => r.id && Number.isFinite(r.idx))
      .sort((a, b) => a.idx - b.idx)
  }, [])

  /** Write every rendered row's `--wy` from the id-keyed map (recycled rows get the RIGHT
   *  note's offset, or 0), resolving each row's note id via `notesRef[data-index]`. */
  const paintOffsets = useCallback(() => {
    const sc = scrollerEl
    if (!sc) return
    const map = waveRef.current
    for (const el of sc.querySelectorAll<HTMLElement>('[data-index]')) {
      const id = notesRef.current[Number(el.dataset.index)]?.id
      const off = (id && map.get(id)?.off) || 0
      el.style.setProperty('--wy', `${off}px`)
    }
  }, [scrollerEl])

  const startLoop = useCallback(() => {
    if (tickRef.current) return // already running; it picks up freshly-seeded entries
    const tick = (data: { delta: number }) => {
      const sc = scrollerEl
      if (!sc) {
        cancelFrame(tick)
        tickRef.current = null
        waveRef.current.clear()
        setWaveSettling(false)
        return
      }
      const map = waveRef.current

      // 1. Integrate each offset toward 0 (semi-implicit Euler). Delayed rows just count
      //    down so the settle starts from the bottom and the wave travels up.
      for (const s of map.values()) {
        if (s.delay > 0) {
          s.delay -= data.delta
          continue
        }
        const next = springStep(s, data.delta, STIFFNESS, DAMPING)
        s.off = next.off
        s.vel = next.vel
      }

      // 2. `pbd` only: up-only, bottom→top non-overlap projection on the ordered offsets.
      //    A row the wave reaches that wasn't seeded gets created at rest (off from the
      //    projection, vel 0) so the shove can propagate to it — mirrors the spike's lazy
      //    `get(id)` that springs un-seeded rows.
      if (modelRef.current === 'pbd') {
        const rows = orderedRows(sc)
        const projected = projectNoOverlap(
          rows.map((r) => map.get(r.id)?.off ?? 0),
          PROJ_PASSES,
        )
        rows.forEach((r, i) => {
          const off = projected[i] ?? 0
          const s = map.get(r.id)
          if (s) s.off = off
          else if (off !== 0) map.set(r.id, { off, vel: 0, delay: 0 })
        })
      }

      // 3. Retire settled rows; stop when nothing is moving or waiting.
      let active = false
      for (const [id, s] of map) {
        if (s.delay > 0) active = true
        else if (Math.abs(s.off) < 0.05 && Math.abs(s.vel) < 0.5) map.delete(id)
        else active = true
      }
      paintOffsets()
      if (!active) {
        cancelFrame(tick)
        tickRef.current = null
        map.clear()
        setWaveSettling(false)
      }
    }
    tickRef.current = tick
    frame.update(tick, true)
  }, [scrollerEl, orderedRows, paintOffsets, setWaveSettling])

  // Entrance, fired on a single append. Layout effect (pre-paint) so the seed shows no pop.
  // Mirrors the glide append-detection + shared no-op gates; the wave at-end gate uses plain
  // `isAtEnd(shift + scrollEndThreshold)` (glide's is estimate-aware — kept per-family). `model`
  // is in the dep array (plan Task 9: re-evaluate the gate when the pref flips) but read live via
  // `modelRef` in the loop, not the effect body — touch it here so the exhaustive-deps lint sees
  // a genuine read and the dep isn't pruned.
  useLayoutEffect(() => {
    void model // intentional dep marker (see above) — the value is consumed via `modelRef`
    const len = notes.length
    const grew = len === prevLenRef.current + 1
    prevLenRef.current = len // advance BEFORE the enabled gate, so a switch back to the wave
    // doesn't misread the appends it skipped while disabled as one giant append (mirrors glide).
    if (!enabled) return // only the selected strategy acts (both runners are always called)
    if (!grew) return
    const sc = scrollerEl
    if (!sc) return

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    const newIndex = len - 1
    const newNode = sc.querySelector<HTMLElement>(`[data-index="${newIndex}"]`)
    if (!newNode) return
    const shift = newNode.offsetHeight // transform-immune (matches virtual-core's measure)
    if (shift <= 0) return

    // Only reveal when the user was pinned to the bottom (not browsing history). The append
    // grew getTotalSize by the still-UNMEASURED new row's content-aware ESTIMATE, not its real
    // height, so distance-from-end reads ≈ that estimate; widen the threshold by max(real,
    // estimate). A tall note's estimate overshoots its real height by >scrollEndThreshold, so
    // `shift` alone would read the bottom-pinned user as "not at end" and skip the reveal
    // entirely — the bug 9a9fc11 fixed for glide; the isAtEnd mechanism is family-agnostic, so
    // the wave needs the same guard. `max` also covers a row already measured (growth == real
    // >= estimate). Mirrors glideReveal.ts.
    const estRow = virtualizer.options.estimateSize(newIndex)
    const grewBy = Math.max(shift, estRow)
    if (!virtualizer.isAtEnd(grewBy + virtualizer.options.scrollEndThreshold)) return

    // Real append: own the reveal. `waveSettling` extends the §Guard suppression from the
    // append render through the spring retire (Feed reads it into `suppressFollow`).
    setWaveSettling(true)
    sc.scrollTop = sc.scrollHeight // pin to the true bottom; the wave rises via `--wy`
    const map = waveRef.current
    for (const { id, idx } of orderedRows(sc)) {
      if (idx > newIndex) continue
      const d = newIndex - idx // 0 = the newcomer itself, 1 = neighbour above, …
      map.set(id, { off: shift, vel: 0, delay: d * STAGGER_MS })
    }
    paintOffsets() // first paint: whole stack at +shift (newcomer below the fold), no pop
    startLoop()
  }, [
    enabled,
    model,
    notes,
    scrollerEl,
    virtualizer,
    orderedRows,
    paintOffsets,
    startLoop,
    setWaveSettling,
  ])

  // Cancel an in-flight wave on unmount (the frame loop is detached from React).
  useEffect(
    () => () => {
      if (tickRef.current) cancelFrame(tickRef.current)
    },
    [],
  )
}
