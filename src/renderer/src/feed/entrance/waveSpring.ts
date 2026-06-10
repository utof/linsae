/**
 * One semi-implicit (symplectic) Euler step of a critically-ish damped spring pulling
 * `off` toward 0. `dtMs` is clamped to 32ms so a long frame can't explode a stiff spring.
 * @see src/renderer/src/dev/RevealPlayground.tsx (the proven loop)
 */
export function springStep(
  s: { off: number; vel: number },
  dtMs: number,
  stiffness: number,
  damping: number,
): { off: number; vel: number } {
  const dt = Math.min(dtMs, 32) / 1000
  const a = -stiffness * s.off - damping * s.vel
  const vel = s.vel + a * dt
  return { off: s.off + vel * dt, vel }
}
