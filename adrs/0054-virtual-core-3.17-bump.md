# 0054 — Bump react-virtual to 3.14.5 / virtual-core to 3.17.3

Status: accepted (v0.7)

## Context

v0.7 (session-persistence) adds feed-scroll-restore on top of the existing chat-shaped
`anchorTo: 'end'` virtualizer (ADR 0005). The v0.7 spec justified bumping virtual-core
3.16.1 → 3.17.3 on three closed/merged upstream fixes that *looked* squarely on the
surfaces this app exercises (scrolling backward into never-rendered rows, a growing
end-anchored last item, a reflow of above-viewport rows while scrolled up):

- **TanStack/virtual#1199** — `fix(virtual-core): adjust scroll on first measurement
  during backward scroll`. The **default** `shouldAdjustScrollPositionOnItemSizeChange`
  predicate skipped scroll compensation for any above-viewport resize while scrolling
  backward, including the FIRST measurement of a row (estimate → real height). Scrolling
  up into never-before-rendered rows could jump.
- **TanStack/virtual#1209** — `fix(virtual-core): sync scrollOffset in
  applyScrollAdjustment so end-anchored resize is not lost to browser clamp`. With
  `anchorTo: 'end'` and a growing last item (this app's send-glide / make-room reveal —
  ADR 0019/0020), the viewport drifted away from the end starting on the second resize
  tick: the scrollTop write landed before the consumer re-rendered the sizer to its new
  height, so the browser clamped it back, no scroll event fired, and the next tick's
  "was at end" check read stale and gave up.
- **TanStack/virtual#1212** — `fix(virtual-core): viewport drifts when above-viewport
  rows resize over multiple frames`. Per the PR, the **default** shouldAdjust predicate
  skipped compensation for multi-frame reflows while a mis-held `isScrolling` flag
  classified the direction as `'backward'`, so only ~1 frame in 9 was compensated.

## Correction discovered during Task 0.2 (verified in the impl, not just upstream)

Writing the regression smoke, I traced these fixes into *this app's* code and found the
spec's premise is only partly right — the smoke cannot be a version gate for #1199/#1212:

- **Feed overrides the very predicate #1199/#1212 fixed.** `src/renderer/src/feed/
  Feed.tsx:622-623` assigns a **custom** `shouldAdjustScrollPositionOnItemSizeChange`,
  always-true when idle (`morphingIndexRef.current === null && !suppressFollow`).
  virtual-core consults the **default** predicate branch only when no custom predicate is
  set — the ternary at `@tanstack/virtual-core/dist/esm/index.js:849`, whose `else` branch
  is `:869`.
- **#1199's entire production change is one line in that default branch.** `gh pr diff
  1199 --repo TanStack/virtual` touches `virtual-core/src/index.ts` at exactly one place:
  it adds `!this.itemSizeCache.has(key) ||` to the default predicate. Its own test is named
  *"backward-scroll skips scroll-position adjustment **by default**"*. Because Feed supplies
  a custom predicate on every render, that branch — and #1199's fix — never runs for the
  Feed. Feed's always-true predicate ALREADY compensates first-measurement during backward
  scroll, so **Feed was never #1199-vulnerable.** (Trade-off, noted for completeness: the
  always-true predicate also compensates *re-measurements*, the cascade #1199's default
  clause deliberately avoids — but Feed rows rarely re-measure during a pure scroll, so the
  real risk is low.)
- **#1212 is bypassed by the same mechanism.** Its symptom, per the PR, is the *default*
  predicate skipping under the mis-held `isScrolling` flag; Feed's always-true override
  never skips, so the symptom isn't reachable through Feed on either version.
- **What DOES help Feed is #1209** — a predicate-**independent** clamp in the
  `wasAtEnd → applyScrollAdjustment` path (`index.js:847` sets `wasAtEnd`; `:876`/`:877`
  apply the adjustment regardless of the predicate). That is the end-anchor resize path the
  send-glide / make-room reveal drives, and the one assertion #1 exercises.

I confirmed the fixed lib's behavior empirically: after a one-step backward jump into
never-measured rows, the top-visible note resolves from its estimate position to its
measured position on the **single** measurement frame (a ~2-row shift), then is rock-stable
for 40+ frames. That shift is unavoidable estimate→measured resolution, present on both
3.16.1 and 3.17.3 — not the #1199 jump.

## Decision

**Keep the bump** `@tanstack/react-virtual` → `^3.14.5` (pulling `virtual-core@3.17.3`).
It is a net win independent of #1199/#1212: **#1209's clamp hardens the end-anchor path the
app actually uses**, the change is otherwise harmless, and it future-proofs the moment
Feed's custom predicate is ever relaxed to the default (see Consequences). Task 0.1 lands
the bump.

**Add `scripts/feed-scroll-smoke.mjs` (`pnpm smoke:feed`) as a Playwright `_electron`
APP-BEHAVIOR gate — NOT a version gate for #1199/#1212**, which is structurally impossible
for Feed's configuration (above). It seeds 120 plain notes (badly overflowing the default
1280×800 window), reloads, then checks — each via **poll-until-stable**, not fixed settle
sleeps:

1. **Anchored to end** — a freshly-loaded overflowing feed sits within `DRIFT_TOLERANCE_PX`
   (4px) of the bottom. Predicate-independent; exercises the #1209 end-anchor path — though
   as a static at-load check it does not reproduce #1209's actual failure shape (a last item
   *growing over multiple resize ticks*, the send-glide / make-room path), the same honesty
   caveat assertion 3 carries for #1212.
2. **Backward jump settles to a stable anchor** — jump from the bottom to ~15% down in one
   step (most rows above the last-rendered window have never been measured), settle, then
   assert the feed reached a *stable, valid anchor*: a top-visible note exists, its row
   straddles the scroller's top edge (visual offset within one row-height of it), and it
   does **not** keep drifting over a further window. It deliberately **tolerates** the
   one-frame estimate→measured shift the fixed lib legitimately shows (asserting
   immediate == settled would false-fail the fixed lib, as measured above). The failure
   modes it gates are runaway drift, blanking, and oscillation — the ones Batch 3's restore
   depends on.
3. **Dock width change does not drift the feed** — scroll to a mid-list position, toggle the
   right dock (`button[aria-label="toggle backlinks"]`, which changes the feed's band
   `maxWidth` — ADR 0047), and assert the same top-visible note stays within
   `DRIFT_TOLERANCE_PX` of its offset. A general behavioral guard, **not** a #1212 version
   gate.

**This ADR supersedes the v0.7 spec's §"The dependency bump" premise** — that the smoke
gates #1199/#1212 against this app's real Feed. It does not, and cannot, for Feed's
configuration; it gates Feed's actual scroll-anchoring behavior plus #1209's end-anchor
path instead.

Note on assertion 2's scope: a literal data-**prepend** smoke (older history loaded above
already-rendered notes) is not possible against this app today — there is no scroll-back
pagination yet (`src/renderer/src/App.tsx:100-108`'s query comment cites issue #20;
`notes:create`'s `created_at` is always `Date.now()` server-side, `src/main/save-note.ts:104`,
so a new note can never land above existing ones).

## Alternatives

- **Patch 3.16.1 locally** (a local override / patch-package for #1199/#1209/#1212).
  Rejected: #1209 is the fix we actually benefit from and it's released; carrying a local
  patch is pure maintenance debt over just taking the release.
- **Defer the bump; build feed-scroll-restore (Batch 3) on 3.16.1.** Rejected: #1209's
  end-anchor clamp is exactly the send-glide / make-room path v0.7 leans on; shipping on the
  clamped base risks reintroducing the end-drift as a "new" bug in a later batch.
- **Make the smoke a TRUE #1199/#1212 gate by pointing it at a virtualized surface that uses
  the DEFAULT predicate.** Deferred: no such surface is load-bearing for v0.7, and the point
  of this gate is Feed's actual restore behavior, not upstream's default-predicate fixes.

## Consequences

- **`pnpm smoke:feed` is the app-behavior regression gate for Feed scroll-anchoring and for
  Batch 3's feed-scroll-restore.** It must stay green through the branch; a future
  virtual-core bump should re-run it before merging.
- **The restore round-trip assertion lands in Batch 3, not here** — this task only gates the
  pre-existing behavior (anchor-to-end, stable-anchor-after-backward-jump, dock-toggle
  no-drift) that the restore feature builds on.
- **happy-dom cannot cover this class of behavior** — no layout engine means `scrollHeight`/
  `getBoundingClientRect` are meaningless in the existing Vitest/RTL suite. The `_electron`
  smoke is the only real-layout check in the repo for scroll-anchoring.
- **Deferred follow-up:** a literal data-prepend stability smoke (seeding a second
  `better-sqlite3` connection against `<userDataDir>/linsae.db` with a backdated
  `created_at`, then triggering a live refetch without a full reload) becomes a natural
  integration test once scroll-back pagination ships (issue #20) — not before, since there
  is nothing to prepend into today.
- **Candidate future investigation (OUT OF SCOPE for v0.7 — do NOT touch Feed's predicate in
  this batch):** now that virtual-core's *default* predicate compensates first-measurement
  during backward scroll (#1199), evaluate whether Feed's custom always-true predicate —
  originally needed to force that compensation — can be relaxed to the default, shedding the
  re-measurement-cascade trade-off. Requires its own spike and must keep honoring the
  morph / send / wave suppression the current predicate encodes. Tracked in
  [#172](https://github.com/utof/linsae/issues/172).

## Sources

- https://github.com/TanStack/virtual/pull/1199 — "fix(virtual-core): adjust scroll on
  first measurement during backward scroll" (merged/closed). Sole production change: the
  `!this.itemSizeCache.has(key) ||` clause in the DEFAULT predicate.
- https://github.com/TanStack/virtual/pull/1209 — "fix(virtual-core): sync `scrollOffset`
  in `applyScrollAdjustment` so end-anchored resize is not lost to browser clamp"
  (merged/closed). The predicate-independent end-anchor fix this app benefits from.
- https://github.com/TanStack/virtual/pull/1212 — "fix(virtual-core): viewport drifts when
  above-viewport rows resize over multiple frames" (merged/closed).
- `src/renderer/src/feed/Feed.tsx:622-623` — the custom
  `shouldAdjustScrollPositionOnItemSizeChange` override (always-true when idle) that makes
  this an app-behavior gate rather than a #1199/#1212 version gate.
- `@tanstack/virtual-core/dist/esm/index.js:849` (predicate ternary), `:869` (default branch
  carrying #1199's clause), `:847`/`:876`/`:877` (predicate-independent `wasAtEnd` →
  `applyScrollAdjustment` path #1209 hardened).
- `scripts/thread-smoke.mjs` — the `_electron` launch/seed/teardown template this smoke
  mirrors, including its poll-until-condition loop.
- `adrs/0005-tanstack-virtual.md` — the original migration this bump follows on from.
- `adrs/0047-feed-default-width-docks-fill-gutters.md` — the feed-band mechanism assertion 3
  exercises via the dock toggle.
