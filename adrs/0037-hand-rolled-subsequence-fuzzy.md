# 0037 — Hand-rolled subsequence fuzzy matcher for the canvas pickers

Status: accepted (v0.4.1)

## Context

The canvas `/` placement picker and the new edge-target picker both need fuzzy ranking over a
small in-memory candidate set (all placed notes, capped at ~500 from `notes:list`). The
requirements: subsequence matching (e.g. `cu` matches `claude`), fzf-style scoring (consecutive
run bonus + word-boundary bonus), matched-character indices for highlight rendering, and a result
sorted by descending score.

The feed and global note search keep FTS5 / `bm25()` on the main-process side (#130) — the
pickers are a different use-case: the candidate set is already in renderer memory, round-trips
are unnecessary, and subsequence semantics are better than prefix/BM25 for a 2–4 char query
over short titles.

## Decision

A pure, hand-rolled `src/renderer/src/lib/fuzzy.ts` (`fuzzyMatch`) — ~58 lines, zero runtime
dependencies. The algorithm: iterate the query chars in order over the title (subsequence
check); accumulate a score with +5 per consecutive-position char and +10 per word-boundary hit
(`ti === 0` or prior char is whitespace/hyphen/underscore/slash); track the matched char indices.
Both canvas pickers pass `shouldFilter={false}` to cmdk and sort by `fuzzyMatch` score instead,
so cmdk's own filter does not re-order the pre-ranked results.

## Alternatives

- **A fuzzy library (fuse.js / fzf / cmdk's built-in filter)** — rejected. A runtime dep for a
  ~30-line algorithm is a FIRE trigger per CLAUDE.md verify-or-not policy (a new `import` for a
  package not already in the repo). cmdk's own `shouldFilter` would also re-order the pre-ranked
  results unless disabled — defeating the point. The hand-rolled matcher is exact, instant, and
  has no version surface.
- **FTS5 for the pickers** — rejected. A main-process round-trip + BM25 prefix semantics for a
  tiny in-memory set where a subsequence scan is exact and synchronous. FTS5 remains the right
  choice for the full-corpus feed/global search (#130).

## Consequences

- Feed/global fuzzy (#130) can reuse or layer on the same `fuzzyMatch` later — the function is
  exported and self-contained.
- The `matched` indices are computed against the lowercased title (see `src/renderer/src/lib/fuzzy.ts:18`).
  For most titles this is identity-safe; length-shifting Unicode codepoints (e.g. `'İ'`→`'i̇'`)
  could shift subsequent indices by 1. Accepted v1 limitation: such titles may mis-highlight one
  character but will still rank and match correctly.
- The `/` placement picker was rewired from cmdk's filter to `fuzzyMatch` in Task 8 — a
  behaviour change users can observe (different ranking on ambiguous queries).

## Sources

- `docs/specs/v0.4.1-canvas-edges.md` §4 (decision 5), §9
- `src/renderer/src/lib/fuzzy.ts` — the matcher implementation
- Issue #130 (feed/global fuzzy — the future consumer that keeps FTS5 for now)
- CLAUDE.md §Verify-or-not — the FIRE trigger for new runtime imports
