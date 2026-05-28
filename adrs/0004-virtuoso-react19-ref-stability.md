# ADR 0004 — Memoize all `<Virtuoso>` prop callbacks for React 19 ref-identity stability

**Date:** 2026-05-28.
**Status:** accepted (v0.1.2).
**Reassessment trigger:** when react-virtuoso publishes a 4.19+ release whose changelog references React 19 ref-callback semantics, OR if a React 19.x minor release softens the ref-identity churn behavior, OR if we migrate off OSS Virtuoso.

## Context

The v0.1.2 feed thumb saga (commits `b35d293` → `823d506`) culminated in a "Maximum update depth exceeded" crash trace whose top frames are `forceStoreRerender → updateStoreInstance → commitHookEffectListMount` (the React internal that backs `useSyncExternalStore`'s commit-time snapshot recheck) and whose component-stack bottom is `react-virtuoso.js:2343` — verified at `node_modules/.pnpm/react-virtuoso@4.18.7_*/node_modules/react-virtuoso/dist/index.mjs:2323` as the line `E.useSyncExternalStore(H, () => it(S), () => it(S))` inside Virtuoso's `useEmitterValue` factory. Reproduces on **both slow and fast scroll**, intermittently. ErrorBoundary catches it; React 19 then attempts to recreate the subtree, which the user observes as a blank-screen flash + scroll-position teleport.

Multiple symptom-level fix attempts failed: per-item `heightEstimates`, `defaultItemHeight=60` + `overscan=1500`, cap-aware estimator with coalesce timer, `skipAnimationFrameInResizeObserver`, a per-note ResizeObserver measurement cache feeding a custom thumb (Path A), microtask-batching of the cache's tick bumps, and a root error boundary. None addressed the cascade itself — they reduced its frequency or made it catchable, not its trigger.

A fresh investigation (Opus subagent, 2026-05-28) with context7 + WebSearch + GitHub-issue trawling identified the load-bearing rung. Two pieces of evidence:

1. **`react-virtuoso@4.18.7` runs the `useSyncExternalStore` codepath under React 19.** Verified at `dist/index.mjs:2336` — the version check `parseInt(E.version) >= 18 ? I : w` selects `I`, the path defined at `dist/index.mjs:2318-2327`, which calls `useSyncExternalStore` per emitter-key. Virtuoso's inner list-state component subscribes to ~14 emitters; the viewport, scroller, header, footer, and TopItemList components each subscribe to several more. **Each `A("…")` emitter read in Virtuoso's source is one nested `useSyncExternalStore` subscription.**
2. **React 19 changed ref-callback semantics.** A ref-callback whose function identity differs from the previous render is treated as detach (cleanup) + reattach (setup). Inline ref callbacks recreated each render run their cleanup and setup once per render. Documented at https://tkdodo.eu/blog/ref-callbacks-react-19-and-the-compiler. The closest publicly-reported analog is `radix-ui/primitives#3799` — Radix UI's `@radix-ui/react-compose-refs` hits the same "Maximum update depth exceeded" trip in React 19 due to ref-callback identity churn, with the same proposed fixes (memoize the composed ref callback).

In `Feed.tsx` (pre-fix), the `<Virtuoso>` props `scrollerRef`, `itemContent`, `computeItemKey`, and `initialTopMostItemIndex` were all inline expressions, recreated on every Feed re-render. Virtuoso's internal `co()` useEffect (`dist/index.mjs:2380-2385`) has the user-supplied `scrollerRef` in its deps array — when the prop's identity changes, the effect's cleanup + setup runs, writing scroll state into Virtuoso's internal stream. That stream write notifies all subscribers of the affected emitters, each of which calls `forceStoreRerender`. With dozens of subscribers and React's nested-update depth limit at ~50, the cascade exceeds the limit. StrictMode's effect doubling in dev halves the headroom further.

The cache's own `useSyncExternalStore` subscription was a contributing rung but not the dominant multiplier — microtask-batching (commit `7e6c62a`) collapsed its bump rate to ONE notification per scroll-burst, yet the cascade still tripped.

## Decision

**Wrap every callback/object prop on `<Virtuoso>` in `useCallback` / `useMemo`** at the Feed component level. Specifically in `src/renderer/src/feed/Feed.tsx`:

- `scrollerRef` → `useCallback([])`. Captures only refs and a setState setter, both of which have stable identity.
- `computeItemKey` → `useCallback([])`. Pure function of `(_, note) => note.id`.
- `initialTopMostItemIndex` → `useMemo([])`. Virtuoso reads this only at mount, so freezing it at first render captures the correct anchor index. The biome-ignore on `useExhaustiveDependencies` is intentional and documented inline.
- `itemContent` → `useCallback([focusedId, onFocus, onWikilinkClick, resolveSlug, onEdit, onDelete, onCopyLink])`. These are the actual semantic dependencies — the callback identity is stable across renders where none of these changed.

Restored `skipAnimationFrameInResizeObserver={true}` (originally added in `da9fad7`, removed in `823d506` on a wrong hypothesis). With the memoized callbacks preventing the ref-identity churn, the prop can do its intended job of reducing flicker during fast scroll without re-introducing the cascade.

Restored the benign-error suppressor on `window.error` that mutes the "ResizeObserver loop completed with undelivered notifications" warnings the prop sometimes produces, per `petyosi/react-virtuoso#1049`.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Drop the measurement-cache `useSyncExternalStore` subscription; pass `useScrollThumb` a getter callback.** | Would address one cascade rung but not the dominant one (ref-callback churn). Introduces a real correctness regression: `modelTotal` is no longer reactive, so the thumb wouldn't update until a scroll event arrives. Also touches an exported function signature (hard-gate breach) without commensurate benefit. |
| **Path B — drop Virtuoso entirely; use plain `<div>` + `content-visibility: auto; contain-intrinsic-size: auto N`.** | High-risk Phase replacement, not a polish-batch fix. Eliminates virtualization (cap ~2-5k mounted bubbles before React diff cost dominates); needs `IntersectionObserver` for near-bottom detection; programmatic `scrollTo` lands short if `contain-intrinsic-size` under-estimates. Reserved as escape hatch if symptoms persist after this ADR. |
| **Switch to `virtua` or `@tanstack/react-virtual`.** | Spec §Stack explicitly chose vanilla Virtuoso for variable-height chat. CLAUDE.md's "3+ failed fixes ⇒ question architecture" rule fires, but the memoization fix targets a previously-unidentified rung — switching libraries should follow only if the targeted fix fails. |
| **Disable StrictMode in dev to widen the cascade headroom.** | Diagnostic only; never ship. StrictMode's effect-doubling is exactly what surfaced this bug pre-production. Removing it would mask the next React 19 footgun the same way it masked this one. |
| **Downgrade to React 18.** | Breaks spec §Stack (React 19 strict + concurrent features). Not on the table. |

## Consequences

- Future Feed maintainers must NOT inline-define `<Virtuoso>` props without justification. If a new prop is needed, memoize it. This file is the durable record of why.
- The same care extends to any `<Virtuoso>` mount anywhere else in the renderer — but as of v0.1.2 there is only one, in `Feed.tsx`.
- If a future React minor release softens the ref-callback churn behavior (e.g., React Compiler auto-memoizes inline functions), some of these `useCallback`/`useMemo` wrappers become redundant. The biome-ignore for `initialTopMostItemIndex` remains correct regardless because Virtuoso ignores post-mount changes to that prop anyway.
- The `dist/index.mjs:2380-2385` `co()` useEffect's behavior is private API — if Virtuoso refactors its scroller effect to take a stable callback ref internally, our memoization remains harmless but no longer load-bearing.

## Sources

- React 19 ref-callback semantics: https://tkdodo.eu/blog/ref-callbacks-react-19-and-the-compiler
- Closest documented analog: https://github.com/radix-ui/primitives/issues/3799
- Virtuoso 4.18.5 `useSyncExternalStore` migration: https://x.com/petyosi/status/1758779223504801817
- `useSyncExternalStore` infinite-loop docs: https://react.dev/reference/react/useSyncExternalStore
- `skipAnimationFrameInResizeObserver` benign-warning pairing: https://github.com/petyosi/react-virtuoso/issues/1049
- React `forceStoreRerender` source: `react-dom/cjs/react-dom.development.js` (verified via context7 `/facebook/react` snapshot)
- Installed Virtuoso source: `node_modules/.pnpm/react-virtuoso@4.18.7_*/node_modules/react-virtuoso/dist/index.mjs:2310-2360`, `:2380-2419`, `:2336`
