/**
 * Hand-rolled case-insensitive subsequence fuzzy matcher (no dep, spec §9).
 * Scores consecutive runs + word-boundary hits higher (fzf-style), returns
 * descending score with matched-char indices for highlight. Used by the canvas
 * `/` picker and the edge-target picker; feed/global search keeps FTS (#130).
 * @see docs/specs/v0.4.1-canvas-edges.md §4
 */
export interface FuzzyResult {
  id: string
  title: string
  score: number
  /** indices into the ORIGINAL title where query chars matched (for <mark>). */
  matched: number[]
}

function scoreOne(query: string, title: string): { score: number; matched: number[] } | null {
  const q = query.toLowerCase()
  const t = title.toLowerCase()
  const matched: number[] = []
  let qi = 0
  let score = 0
  let prevIdx = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    matched.push(ti)
    // consecutive-run bonus
    if (ti === prevIdx + 1) score += 5
    // word-boundary bonus (start, or after a space/punctuation)
    if (ti === 0 || /[\s\-_/]/.test(t[ti - 1] ?? '')) score += 10
    score += 1
    prevIdx = ti
    qi++
  }
  if (qi < q.length) return null // not a full subsequence
  // shorter titles rank slightly higher for the same match
  score -= title.length * 0.01
  return { score, matched }
}

export function fuzzyMatch(
  query: string,
  candidates: ReadonlyArray<{ id: string; title: string }>,
): FuzzyResult[] {
  if (query.trim().length === 0)
    return candidates.map((c) => ({ id: c.id, title: c.title, score: 0, matched: [] }))
  const out: FuzzyResult[] = []
  for (const c of candidates) {
    const m = scoreOne(query, c.title)
    if (m) out.push({ id: c.id, title: c.title, score: m.score, matched: m.matched })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}
