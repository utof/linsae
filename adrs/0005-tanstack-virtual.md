# ADR 0005 — Replace `react-virtuoso` with `@tanstack/react-virtual` for the feed

**Date:** 2026-05-28.
**Status:** accepted (v0.1.2).
**Reassessment trigger:** if `@tanstack/react-virtual` ever drops the chat-shaped `anchorTo: 'end'` / `followOnAppend` / `scrollToEnd` APIs we depend on; if `react-virtuoso@5.x` ships an OSS chat component matching what we get from tanstack; if the feed grows past ~5k mounted virtual items and tanstack's per-item ResizeObserver overhead becomes the bottleneck.

## Context

The v0.1.2-polish saga (commits `b35d293` → `530e3a0`) was nine consecutive attempts to make OSS `react-virtuoso@4.18.7` deliver a stable chat-feed scroll experience:

- `b35d293` `defaultItemHeight=60` + `overscan=1500` to reduce thumb wobble magnitude
- `a1d2076` per-item `heightEstimates` array
- `df2853b` cap-aware `heightEstimates` + 100 ms coalesce
- `da9fad7` `skipAnimationFrameInResizeObserver` + benign-error suppressor
- `6c8de79` per-note measurement cache feeding a custom scrollbar thumb (Path A)
- `bc1478d` cold-cache thumb clamp + text-length cold-cache estimate
- `7e6c62a` microtask-batched cache bumps + root `ErrorBoundary`
- `823d506` removed `skipAnimationFrameInResizeObserver` on a wrong hypothesis (reverted in `530e3a0`)
- `526d6b3` memoize all inline `<Virtuoso>` props for React 19 ref-callback stability (ADR 0004)
- `2a25cea` `scrollSeekConfiguration` with placeholder during fast scroll (reverted in `530e3a0` after producing visible flicker)

Each attempt addressed a real symptom but the underlying class of bug — scrollHeight oscillating as Virtuoso swapped item-size estimates for real measurements during scroll, combined with `alignToBottom`'s anchor reconciliation moving `scrollTop` mid-scroll — kept producing new failure modes. The maintainer himself confirmed at `petyosi/react-virtuoso#1240` (May 2025): *"This is a limitation... addressed in the [commercial] MessageList component."* The OSS `react-virtuoso` is a general-purpose virtual list. Chat-specific scroll stability lives in the paid product (`@virtuoso.dev/message-list`, $168/seat/year first year + perpetual prod license).

## Decision

Migrate the feed to `@tanstack/react-virtual@3.13.26` (depending on `@tanstack/virtual-core@3.16.0`). The migration is justified by three concrete API surfaces tanstack ships in its chat-mode that Virtuoso OSS doesn't:

- **`anchorTo: 'end'`** keeps prepended history items visually stable. When older messages are loaded above the viewport, tanstack captures the visible item by its stable key before the data update, finds the same keyed item after the prepend, and adjusts `scrollTop` so the message stays in place. Also handles streaming/growing tail items the same way.
- **`followOnAppend: true`** auto-scrolls to the newly-appended item only when the user is within `scrollEndThreshold` of the bottom. Replaces our manual `notes.length` `useEffect` re-pin guard from the Virtuoso era.
- **`scrollToEnd()` / `isAtEnd()` / `getDistanceFromEnd()`** are first-class methods. The previous Feed maintained its own `atBottomRef`, custom 10 px slack check on scroll events, and a separate `ResizeObserver` that re-pinned via `scrollTop = scrollHeight`. All replaced by tanstack's `isAtEnd()` in a single line.

The architectural property that makes this work: tanstack-virtual's inner container has its CSS `height` set to `virtualizer.getTotalSize()` exactly. The browser's `scrollEl.scrollHeight` reads that exact number. When off-screen items get measured (their estimate replaced by real size), the inner container's height changes, and the browser's **native scroll-anchoring** keeps visible content stable. Virtuoso's coordinate system overrode browser scroll behavior to achieve `alignToBottom`'s reversed semantics, which is precisely what prevented native anchoring from working.

Concretely:
- `src/renderer/src/feed/Feed.tsx` rewritten using `useVirtualizer({ anchorTo: 'end', followOnAppend, scrollEndThreshold, getItemKey, estimateSize, measureElement })`.
- `src/renderer/src/feed/measurementCache.ts` + `measurementCache.test.ts` deleted (tanstack's `measureElement` ref pattern subsumes them).
- `src/renderer/src/feed/Feed.tsx` no longer contains `MeasuredBubble`, `estimateBubbleHeight`, the cache subscription, or the `skipAnimationFrameInResizeObserver` / benign-error-suppressor pair.
- `useScrollThumb` in `src/renderer/src/components/ScrollArea.tsx` simplified — the `totalHeight?: number` override parameter is removed since `scrollEl.scrollHeight` is now precise. Thumb math is identical for `<ScrollArea>`-wrapped surfaces (BacklinksPane, CommandPalette).

ADR 0004 (memoize Virtuoso prop callbacks for React 19 ref-stability) is retained as historical record. Its lesson generalizes — the scroller ref callback in the new Feed is `useCallback`-memoized for the same React 19 reason, even though tanstack-virtual doesn't have an internal `useEmitterValue` subscription cascade for it to feed.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Buy `@virtuoso.dev/message-list` (commercial)** | Verified: $168/seat/year (1 seat for a solo project), 30-day free dev trial, perpetual production license once paid. Spec §Stack rules out the commercial Virtuoso. The user is the spec owner and could reverse the rule, but chose to stay on free OSS. Honest reading: the commercial product would have solved this in ~30 min of integration; tanstack-virtual is also free and we control more of the layer. Decision was tanstack. |
| **Path B — drop virtualization entirely; plain `<div>` map + `content-visibility: auto; contain-intrinsic-size: auto 80px`** | Browser-native deferred paint with sticky measurements. Free, ~120-200 LoC. Subagent flagged gotchas: `position: sticky` breaks under `content-visibility: auto` ancestor; programmatic `scrollTo` lands short when `contain-intrinsic-size` under-estimates intermediate items. The first isn't a current linsae issue. The second is. Reserved as escape hatch if tanstack proves insufficient. |
| **`virtua` (`inokawa/virtua`)** | ~3 kB, vanilla `useSyncExternalStore`-based, supports reverse scroll + dynamic sizes. Less battle-tested than tanstack's TanStack ecosystem; smaller community / fewer chat-shaped examples. Acceptable second choice. |
| **Stay on `react-virtuoso` and force-pin the cascade** | After ADR 0004's memoization fix, the cascade was reduced but the underlying #1240 scrollHeight oscillation remained — the teleport persisted, fast-scroll lagged. Maintainer's own statement says this is the wrong tool for chat. |

## Consequences

- **No more `useSyncExternalStore` subscription tree** in the feed code path. The Virtuoso emitter cascade (the load-bearing rung the Opus subagent identified, ADR 0004) cannot recur because tanstack-virtual uses standard React state + refs internally, not a Urx-style emitter graph.
- **No measurement cache to maintain.** tanstack handles per-item measurement via the `ref={virtualizer.measureElement}` pattern. The `data-index` attribute on each item wrapper is required for tanstack to identify which index it just measured.
- **No more inline-prop ref-callback churn risk for the feed scroller** — `handleScrollerRef` in Feed.tsx is `useCallback([])`-memoized. ADR 0004's lesson still applies.
- **`useScrollThumb`'s public signature changed**: `(scrollEl, totalHeight?)` → `(scrollEl)`. Called from one site outside the feed (`<ScrollArea>` at `ScrollArea.tsx:464`); that call site already passed no `totalHeight`, so the change is API-clean.
- **Feature deltas tanstack-virtual gives us that we didn't have before**: a first-class "jump to latest" pattern via `isAtEnd()` is now trivial to wire if/when the spec calls for it; `getDistanceFromEnd()` is available if we ever need precise pinned-detection.
- **Known unknowns**: tanstack-virtual's `measureElement` uses a `ResizeObserver` internally per item. In our previous saga the per-item RO was a contributing rung (commit `6c8de79`'s `MeasuredBubble`). Difference now: tanstack-virtual's RO writes feed a stable internal state (no useSyncExternalStore subscriber tree at the Feed boundary), so the same fan-out cannot happen. If we observe instability anyway, the fallback is Path B.
- **Bundle size**: `react-virtuoso@4.18.7` ≈ 45 KB minified; `@tanstack/react-virtual@3.13.26` + `virtual-core@3.16.0` ≈ 9 KB minified. Net reduction.

## Sources

- TanStack Virtual chat docs (canonical pattern): `anchorTo`, `followOnAppend`, `scrollEndThreshold`, `scrollToEnd`, `isAtEnd`, stable `getItemKey` for prepend stability — all verified against installed `node_modules/.pnpm/@tanstack+virtual-core@3.16.0/node_modules/@tanstack/virtual-core/dist/esm/index.d.ts:80-176`
- petyosi/react-virtuoso#1240 — maintainer-confirmed OSS limitation
- virtuoso.dev/pricing — verified commercial-tier costs (2026-05-28 fetch)
- Saga summary in `CLAUDE.md` (project-rules file) `## Feed thumb / scrollHeight saga` section
- ADR 0004 — React 19 ref-callback stability lesson (retained as cross-cutting principle)
