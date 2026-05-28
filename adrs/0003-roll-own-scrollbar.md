# ADR 0003 — Roll our own custom scrollbar instead of adopting a library

**Date:** 2026-05-28.
**Status:** accepted (v0.1.2).
**Reassessment trigger:** the next time a third scroll surface needs the same treatment AND `overlayscrollbars-react` (or a sibling) gains a way to distinguish user-initiated from programmatic scroll events, OR when our custom component picks up enough edge cases that maintaining it costs more than vendoring a library.

## Context

v0.1.2 polish set a 4-part visual spec for scrollbars across the three internal scroll surfaces (`Feed` / `Virtuoso`, `CommandPalette`, `BacklinksPane`):

1. **Default invisible** — quiet by default.
2. **Fade in only on user-initiated scroll** — wheel / trackpad / keyboard. Hold visible 800 ms after the last user input, fade out over ~280 ms.
3. **Fade in on hover** of the scrollable surface — faster (~120 ms).
4. **Bouncy thumb-width expand** on direct hover over the thumb (4 → 8 px, spring overshoot).

Chromium does NOT animate CSS transitions on `::-webkit-scrollbar*` pseudo-elements — long-standing rendering-architecture limitation, https://bugs.chromium.org/p/chromium/issues/detail?id=625354. Native scrollbars can be styled statically but show/hide snaps; there is no path to (3) or (4) with the native scrollbar. (2) is more subtle and is the disqualifying constraint for every library evaluated.

A researcher subagent surveyed (2026-05-28, all sourced):

| Library | Status | Why eliminated |
|---|---|---|
| `overlayscrollbars-react@0.5.6` | Active, MIT, React 19 ✓, has documented `react-virtuoso` integration | **Fails req #2** — `manageScrollbarsAutoHideInstantInteraction` is called on every raw `scroll` event with no user/programmatic distinction. Virtuoso's `followOutput` / `scrollToIndex` / resize-driven re-pins all fire `scroll` and would trigger the visible state. |
| `@radix-ui/react-scroll-area@1.2.10` | Active, MIT, React 19 ✓ | Same `scroll`-event coupling as overlayscrollbars; additionally needs Virtuoso's non-standard `customScrollParent` instead of `scrollerRef`. |
| `simplebar-react@3.3.2` | Active, MIT, React 19 unverified | Two-pass mount required against Virtuoso, must `recalculate()` after every content change. Same req #2 failure. |
| `react-perfect-scrollbar@1.5.8` | Abandoned 2020 | No React 19 support. |
| `react-custom-scrollbars-2@4.5.0` | Abandoned 2022 | Open issues #56 / #57 ("Support React 19") unresolved. |
| `react-scrollbars-custom@4.1.1` | Abandoned 2022 | Same. |

## Decision

**Custom `<ScrollArea>` component + `useScrollThumb` hook** at `src/renderer/src/components/ScrollArea.tsx` (~250 LOC including the hook, component, and `<ScrollThumb>` sub-element). The key insight that makes the custom path uniquely capable of satisfying req #2: **`event.isTrusted` on a `wheel` event is `true` only for genuine pointer/trackpad input, `false` for `dispatchEvent`**. Virtuoso's `scrollTop = value` assignments fire `scroll` events but NEVER fire `wheel` events. So a `wheel` listener gated on `isTrusted` cleanly separates user intent from programmatic scrolling.

Same trick extends to keyboard scroll (req per user 2026-05-28): `keydown` events also carry `isTrusted`, and a small set of scroll-relevant keys (Arrow keys, Page Up/Down, Home/End, Space) cover the keyboard scroll cases the user expects.

Implementation:

1. **`useScrollThumb(scrollEl)`** — accepts an external scrollable `HTMLElement | null`, returns `{ geometry, thumbHovered, areaHovered, set*, onThumbPointerDown }`. Internally:
   - Listens to `scroll` (position updates), `wheel` (`isTrusted` → showAndQueueHide), `keydown` (`isTrusted` + scroll-key set → showAndQueueHide) on the scroll element.
   - `ResizeObserver` on the scroll element AND its immediate children — Virtuoso adds/removes virtualized item nodes without firing scroll, so observing the scroller alone misses content-height changes.
   - Per-element WeakMap is unnecessary because the hook is per-component; one timer ref per hook instance.
2. **`<ScrollThumb>`** — absolute-positioned `<div>` that consumes the hook's state. Bouncy width via `cubic-bezier(0.34, 1.56, 0.64, 1)` on a real DOM node (no Chromium pseudo-element limitation). Opacity transition is ~120 ms on area-hover and ~280 ms on the scroll-recency timeout.
3. **`<ScrollArea>`** — wrapper for surfaces that own their scroll container (`CommandPalette`, `BacklinksPane`). Captures the inner scroll `<div>` via `ref` callback into state (so the effect deps fire when it mounts), forwards into `useScrollThumb`, renders `<ScrollThumb>` as a sibling.
4. **Feed / Virtuoso integration** — uses the hook directly. The scroller is captured via Virtuoso's `scrollerRef` callback into a `useState` mirror of the existing `scrollerRef`. Native scrollbar hidden on the Virtuoso scroller via `node.classList.add('scroll-area-inner')` + `node.style.scrollbarWidth = 'none'` in the callback.

Native scrollbars hidden via the single CSS class `.scroll-area-inner::-webkit-scrollbar { display: none }` (added to the Virtuoso scroller and to the `<ScrollArea>`'s inner div), plus inline `scrollbarWidth: 'none'` for Firefox compatibility. All other scroll surfaces in the app retain native scrollbars.

## Alternatives

- **`overlayscrollbars-react`** — Closest fit; documented Virtuoso integration, React 19 ✓, ~15 kB gzip. Rejected because `manageScrollbarsAutoHideInstantInteraction` fires on every raw `scroll` event. There is no current hook to filter programmatic scrolls; would require upstream change.
- **`@radix-ui/react-scroll-area`** — Already in dep tree transitively via cmdk-adjacent packages. Same `scroll`-event coupling; also forces a `customScrollParent` shape that Virtuoso supports but Feed.tsx would need to be restructured to use.
- **Hover-only (no scroll-recency)** — Drops req #2 entirely; scrollbar shown only when cursor is over the scrollable. Simpler but does not match the spec; user explicitly asked for scroll-on-input visibility.
- **Accept snap behaviour** — Use native scrollbars statically styled; show on `:hover`. Honest about the Chromium limitation but drops bouncy width and the fade animations the user explicitly called out.

## Consequences

**Positive:**
- Visual spec fully achievable (fade timing, bouncy width, hover tiers, user-vs-programmatic distinction).
- No new dependency, no transitive surface; ~250 LOC the team owns end-to-end.
- The `isTrusted` trick is a clean primitive that maps directly to user intent — no heuristics, no per-source-event filtering, no "did Virtuoso scroll recently?" guesses.
- Future scrollable surfaces just wrap with `<ScrollArea>` (or call the hook directly for Virtuoso-shaped components).

**Negative / risks:**
- We now maintain a custom scrollbar component. Edge cases (drag-while-content-changes-size, RTL layout, touch scrolling, screen readers) need to be handled in-house — a library would have absorbed some of these for free.
- Virtuoso's `ResizeObserver`-driven thumb height recalculation requires the observer to track the scroller's CHILDREN, not just the scroller itself, because virtualized items change `scrollHeight` without resizing the scroller. The hook does this but it's a subtle requirement that future maintainers might miss.
- Keyboard scroll only triggers the visible state when the scroll element has focus (browser default). For Virtuoso's scroller div this requires the user to Tab into it; in practice they rarely will. If keyboard-scroll-without-focus becomes a requirement, the listener has to move to `document` and filter targets — small change.
- Chromium pseudo-element transitions might eventually be implemented (the bug is 10+ years old; unlikely but possible). If they are, libraries would suddenly become viable and a re-evaluation would be warranted.

## Sources

- Researcher report — dispatched 2026-05-28, summarized inline above
- Chromium bug 625354 — https://bugs.chromium.org/p/chromium/issues/detail?id=625354 (retrieved 2026-05-28)
- OverlayScrollbars source — `scrollbarsSetup.ts` `manageScrollbarsAutoHideInstantInteraction` confirms raw-`scroll`-event coupling
- `petyosi/react-virtuoso#541` — closed; `data-virtuoso-scroller` attribute requirement for overlay scrollbar integration
- `KingSora/OverlayScrollbars#639` — open reference list including `react-virtuoso` StackBlitz example
- Implementation: `src/renderer/src/components/ScrollArea.tsx`
- Spec interaction: 4 requirements from user feedback over 2026-05-27 → 2026-05-28
