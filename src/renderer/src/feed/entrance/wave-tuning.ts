import { useEffect, useState } from 'react'

/**
 * Live-tunable wave-reveal parameters. The DEFAULTS reproduce the shipped wave exactly
 * (`ampFloor:0` + `ampMult:1` ⇒ seed offset === the note height, the original behaviour);
 * the dev WaveTuner panel overrides them in localStorage so the feel can be dialed in on
 * the real feed without rebuilds. Once values are settled they get baked into DEFAULTS.
 *
 * `ampFloor`/`ampMult` are the perceptibility lever: a SHORT note's rise = its height, so
 * the flip/pbd magnet is sub-perceptible for small notes — a floor (min px) or a multiplier
 * gives short notes a bigger offset so the difference shows. The spring constants tune feel.
 * @see src/renderer/src/feed/entrance/waveReveal.ts (the consumer)
 * @see src/renderer/src/lib/anim-pref.ts (the same localStorage + same-document-event idiom)
 */
export type WaveTuning = {
  /** Minimum seed offset in px (0 = none). A short note rises at least this far. */
  ampFloor: number
  /** Multiplier on the note's height for the seed offset (1 = exact height). */
  ampMult: number
  stiffness: number
  damping: number
  staggerMs: number
  projPasses: number
}

export const DEFAULT_WAVE_TUNING: WaveTuning = {
  ampFloor: 0,
  ampMult: 1,
  stiffness: 180,
  damping: 18,
  staggerMs: 20,
  projPasses: 8,
}

const KEY = 'linsae.waveTuning'
const EVENT = 'linsae:wave-tuning'

/** The per-row seed offset for a note `shift` px tall: `max(shift × ampMult, ampFloor)`. */
export function seedOffset(shift: number, t: WaveTuning): number {
  return Math.max(shift * t.ampMult, t.ampFloor)
}

/** Keep only the known, finite-number keys from an untrusted parsed object. */
function sanitize(o: unknown): Partial<WaveTuning> {
  const out: Partial<WaveTuning> = {}
  if (o && typeof o === 'object') {
    for (const k of Object.keys(DEFAULT_WAVE_TUNING) as (keyof WaveTuning)[]) {
      const v = (o as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}

/** Read the tuning. Missing/legacy/bogus values fall back to DEFAULT_WAVE_TUNING (never throws). */
export function getWaveTuning(): WaveTuning {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT_WAVE_TUNING, ...sanitize(JSON.parse(raw)) } : DEFAULT_WAVE_TUNING
  } catch {
    return DEFAULT_WAVE_TUNING
  }
}

/** Persist a partial override + notify same-document subscribers ({@link useWaveTuning}). */
export function setWaveTuning(patch: Partial<WaveTuning>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...getWaveTuning(), ...patch }))
  window.dispatchEvent(new Event(EVENT))
}

/** Clear all overrides → back to DEFAULT_WAVE_TUNING. */
export function resetWaveTuning(): void {
  localStorage.removeItem(KEY)
  window.dispatchEvent(new Event(EVENT))
}

/** Reactive read of {@link getWaveTuning} — re-renders the caller when the tuning changes. */
export function useWaveTuning(): WaveTuning {
  const [v, setV] = useState(getWaveTuning)
  useEffect(() => {
    const handler = () => setV(getWaveTuning())
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])
  return v
}
