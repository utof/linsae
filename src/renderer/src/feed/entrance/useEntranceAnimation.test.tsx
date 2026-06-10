/**
 * Component tests for the wave entrance (Task 9). happy-dom has NO real layout or scroll
 * engine, so these assert only the MODEL layer — that the wave engine seeds (or, on a
 * no-op, does NOT seed) the per-row `--wy` custom property on the first paint — and the
 * dispatcher's pref routing. Trajectory, the spring settle, and the scroll-snap guard are
 * the numeric harness's job (`scripts/wave-reveal.mjs`); happy-dom cannot reproduce
 * `reconcileScroll` or measure a rising row.
 *
 * We drive `useWaveReveal` (and, for the routing cases, `useEntranceAnimation`) through a
 * tiny host that renders real `data-index` rows and simulates a single append by bumping a
 * `notes`/rows prop — faithfully replaying the real async send pipeline (Composer →
 * createMut → IPC → refetch) is impractical in happy-dom, and the seed we assert happens
 * synchronously in the append layout effect regardless of the pipeline.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../../../../shared/types'
import type { EntranceCtx } from './types'
import { useEntranceAnimation } from './useEntranceAnimation'
import { useWaveReveal } from './waveReveal'

const NOTE_H = 120 // mocked offsetHeight (happy-dom returns 0 → would trip the shift<=0 bail)

function note(id: string): Note {
  return {
    id,
    slug: id,
    body: id,
    type: 'claim',
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  }
}

/** A stub virtualizer exposing only what the runners touch: `isAtEnd` + `options`. */
function stubVirtualizer(atEnd = true): EntranceCtx['virtualizer'] {
  return {
    isAtEnd: vi.fn(() => atEnd),
    options: { scrollEndThreshold: 120, estimateSize: () => 100 },
    // biome-ignore lint/suspicious/noExplicitAny: stub — runners use only isAtEnd + options.
  } as any
}

/** A scroller whose `scrollHeight`/`clientHeight` give the wave room to pin (no real layout). */
function makeScroller(): HTMLDivElement {
  const sc = document.createElement('div')
  Object.defineProperty(sc, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(sc, 'clientHeight', { configurable: true, value: 400 })
  document.body.appendChild(sc)
  return sc
}

/** Render `count` rows with `data-index`, mirroring the real Feed's recycled DOM (no pw-id). */
function paintRows(sc: HTMLElement, count: number): void {
  sc.innerHTML = ''
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div')
    row.dataset.index = String(i)
    sc.appendChild(row)
  }
}

function ctx(
  notes: Note[],
  scrollerEl: HTMLElement,
  over: Partial<EntranceCtx & { sendInFlight: boolean }> = {},
): EntranceCtx & { sendInFlight: boolean } {
  return {
    virtualizer: stubVirtualizer(),
    scrollerEl,
    notes,
    revealingRef: { current: false },
    setRevealing: vi.fn(),
    suppressThumbResizeRef: { current: false },
    setWaveSettling: vi.fn(),
    sendInFlight: false,
    ...over,
  }
}

const wy = (sc: HTMLElement, idx: number) =>
  (sc.querySelector(`[data-index="${idx}"]`) as HTMLElement).style.getPropertyValue('--wy')

let heightSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // happy-dom reports offsetHeight = 0; the wave needs the newcomer's real height as the
  // seed `shift` (and bails on shift <= 0). Mock a non-zero height for the duration.
  heightSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockReturnValue(NOTE_H) as ReturnType<typeof vi.spyOn>
})

afterEach(() => {
  heightSpy.mockRestore()
  document.body.innerHTML = ''
  vi.unstubAllGlobals() // the reduced-motion test stubs matchMedia; unstub so it can't leak
  vi.restoreAllMocks()
})

function WaveHost({
  notes,
  scrollerEl,
  model,
  enabled,
  setWaveSettling,
}: {
  notes: Note[]
  scrollerEl: HTMLElement
  model: 'flip' | 'pbd'
  enabled: boolean
  setWaveSettling: (v: boolean) => void
}) {
  useWaveReveal({ ...ctx(notes, scrollerEl, { setWaveSettling }), model, enabled })
  return null
}

describe('useWaveReveal (model layer; trajectory is the harness’s job)', () => {
  it.each(['flip', 'pbd'] as const)('seeds --wy on the newcomer for %s', (model) => {
    const sc = makeScroller()
    let notes = [note('a'), note('b')]
    paintRows(sc, notes.length)
    const setWaveSettling = vi.fn()
    const { rerender } = render(
      <WaveHost
        notes={notes}
        scrollerEl={sc}
        model={model}
        enabled
        setWaveSettling={setWaveSettling}
      />,
    )

    // Simulate a single append: one more note + one more row, then re-render.
    notes = [...notes, note('c')]
    paintRows(sc, notes.length)
    act(() => {
      rerender(
        <WaveHost
          notes={notes}
          scrollerEl={sc}
          model={model}
          enabled
          setWaveSettling={setWaveSettling}
        />,
      )
    })

    // First paint: the whole stack is seeded at +shift (newcomer below its slot, rising).
    expect(wy(sc, 2)).toBe(`${NOTE_H}px`)
    expect(wy(sc, 2)).not.toBe('0px')
    // setWaveSettling(true) was called at append (the §Guard suppression handoff).
    expect(setWaveSettling).toHaveBeenCalledWith(true)
  })

  it('no-ops (no --wy seeded) under prefers-reduced-motion', () => {
    const matchMedia = vi.fn(() => ({ matches: true }))
    vi.stubGlobal('matchMedia', matchMedia)

    const sc = makeScroller()
    let notes = [note('a'), note('b')]
    paintRows(sc, notes.length)
    const setWaveSettling = vi.fn()
    const { rerender } = render(
      <WaveHost
        notes={notes}
        scrollerEl={sc}
        model="flip"
        enabled
        setWaveSettling={setWaveSettling}
      />,
    )

    notes = [...notes, note('c')]
    paintRows(sc, notes.length)
    act(() => {
      rerender(
        <WaveHost
          notes={notes}
          scrollerEl={sc}
          model="flip"
          enabled
          setWaveSettling={setWaveSettling}
        />,
      )
    })

    expect(wy(sc, 2)).toBe('') // never set → the note just appears
    expect(setWaveSettling).not.toHaveBeenCalled()
  })

  it('no-ops when disabled (a different strategy is selected)', () => {
    const sc = makeScroller()
    let notes = [note('a'), note('b')]
    paintRows(sc, notes.length)
    const setWaveSettling = vi.fn()
    const { rerender } = render(
      <WaveHost
        notes={notes}
        scrollerEl={sc}
        model="flip"
        enabled={false}
        setWaveSettling={setWaveSettling}
      />,
    )

    notes = [...notes, note('c')]
    paintRows(sc, notes.length)
    act(() => {
      rerender(
        <WaveHost
          notes={notes}
          scrollerEl={sc}
          model="flip"
          enabled={false}
          setWaveSettling={setWaveSettling}
        />,
      )
    })

    expect(wy(sc, 2)).toBe('')
    expect(setWaveSettling).not.toHaveBeenCalled()
  })
})

function DispatchHost({ notes, scrollerEl }: { notes: Note[]; scrollerEl: HTMLElement }) {
  useEntranceAnimation(ctx(notes, scrollerEl))
  return null
}

describe('useEntranceAnimation routing', () => {
  it('pref "glide" → the wave seeds NO --wy (glide path; wave early-returns)', async () => {
    localStorage.setItem('linsae.feedEntrance', 'glide')
    const sc = makeScroller()
    let notes = [note('a'), note('b')]
    paintRows(sc, notes.length)
    const { rerender } = render(<DispatchHost notes={notes} scrollerEl={sc} />)

    notes = [...notes, note('c')]
    paintRows(sc, notes.length)
    act(() => rerender(<DispatchHost notes={notes} scrollerEl={sc} />))

    expect(wy(sc, 2)).toBe('') // glide drives scrollTop, never touches --wy
    localStorage.removeItem('linsae.feedEntrance')
  })

  it('pref "pbd" → the wave seeds --wy on the newcomer', () => {
    localStorage.setItem('linsae.feedEntrance', 'pbd')
    const sc = makeScroller()
    let notes = [note('a'), note('b')]
    paintRows(sc, notes.length)
    const { rerender } = render(<DispatchHost notes={notes} scrollerEl={sc} />)

    notes = [...notes, note('c')]
    paintRows(sc, notes.length)
    act(() => rerender(<DispatchHost notes={notes} scrollerEl={sc} />))

    expect(wy(sc, 2)).toBe(`${NOTE_H}px`)
    localStorage.removeItem('linsae.feedEntrance')
  })
})
