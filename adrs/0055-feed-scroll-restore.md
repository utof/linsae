# 0055 — Feed-scroll restore (flash-free seed on an end-anchored virtualizer)

Status: accepted (v0.7)

## Context

The rolling feed is a chat-shaped `@tanstack/react-virtual` list running
`anchorTo: 'end'` (ADR 0005): new notes append at the bottom and the viewport pins there.
v0.7 (session persistence, ADR 0053) wants to restore the *exact* scroll position across
a restart — and to do it **without a visible flash** (no mount-at-bottom-then-jump).

The hard constraint is structural: `@tanstack/react-virtual`'s virtualizer consumes its
seed state (`initialMeasurementsCache`, `initialOffset`) **only at its first render**. An
effect that sets scroll position after mount is a frame too late — the feed paints at the
wrong place first, then jumps. So the restore decision must be made in the render body and
handed to `useVirtualizer` as options on the very first render, and the feed must first
*mount with its notes already present* — a mount on an empty feed locks `scrollOffset` to
0 and the restore silently lands at the top.

There is a second hazard specific to end-anchoring: does `anchorTo:'end'` re-scroll the
feed back to the bottom at boot and clobber a seeded mid-feed offset? (Answered below — it
does not, and we verified why.)

## Decision

**Capture (throttled, not `onChange`).** A native `scroll` listener trailing-throttled to
`FEED_SCROLL_CAPTURE_THROTTLE_MS = 200` (`src/renderer/src/feed/Feed.tsx:102`, `:732-764`)
reports `{ snapshot: virtualizer.takeSnapshot(), offset: scrollOffset, anchor }` up to
`App`, which persists it debounced to `feed.scroll.v1`. The anchor is the **true
top-visible** row (first item whose `end > offset + 1`), *not* `getVirtualItems()[0]`
(that is an overscan row up to `overscan`=8 rows above the viewport top — anchoring on it
persisted a key ~8 notes too high). `onChange`/React `onScroll` were avoided to keep this
off the render path and away from the date-pill's own `onScroll`, and to avoid write-thrash.

**Restore decision, in the render body.** `pickFeedRestore(restore, noteIds)`
(`src/renderer/src/feed/feedScrollRestore.ts:14-23`) returns one of four modes:

| condition | mode | how |
| --- | --- | --- |
| `restore == null` | `default` | chat scroll-to-bottom (pre-v0.7 behavior) |
| `anchor.atEnd` | `bottom` | `scrollToEnd()` |
| every persisted index still maps to the same note id | `seed` | `initialMeasurementsCache` + `initialOffset` (**flash-free**) |
| anchor key still present at a different index | `index` | `scrollToIndex(idx, {align:'start'})` |
| else | `default` | scroll-to-bottom |

`Feed` computes `fr = pickFeedRestore(...)` in the render body via `useMemo`
(`Feed.tsx:484-491`) and **conditionally spreads** the seed into `useVirtualizer` ONLY for
`mode === 'seed'` (`Feed.tsx:537-539`); a plain spread (not `key: cond ? v : undefined`) so
the keys are ABSENT under `exactOptionalPropertyTypes`, never explicit `undefined`. The
`index`/`bottom`/`default` modes are applied in a strictly one-shot `useLayoutEffect`
(`Feed.tsx:693-698`) — `seed` scrolls NOTHING there (it is already applied via the hook
options and must not be clobbered by `scrollToEnd`).

**The seed is consumed only at first render — so `Feed` must FIRST-mount with notes
present.** `App` gates `<Feed>`'s first mount on `snapSettled` AND `notes.length > 0`
(`src/renderer/src/App.tsx:1360`, `:1374-1409`); the boot splash covers the pre-settle gap.
Relaxing the notes-present gate would let `Feed` first-mount on an empty feed, locking
`scrollOffset` to 0 and landing the restore at the top.

### Why `anchorTo:'end'` does NOT override the seed at boot (source-verified)

The concern: virtual-core re-scrolls to the end on `setOptions` whenever
`anchorTo === 'end'`, which would fight the seeded `initialOffset`. It does not — because
that re-scroll is gated on the scroll element already being attached, which it is not at
first render. In the shipped `@tanstack/virtual-core@3.17.3`, the end-anchor block in
`setOptions` is guarded by:

```
prevOptions !== undefined && prevOptions.enabled && merged.enabled
  && merged.anchorTo === "end" && this.scrollElement !== null
```

(`node_modules/@tanstack/virtual-core@3.17.3/dist/esm/index.js:288`). `scrollElement`
starts `null` (`:167`, `:379`) and is only assigned inside the *effect* that observes the
scroller (`:389-396`), which runs after first render. So at the first render — the only
render where the seed is read — `scrollElement === null`, the end-anchor branch is skipped,
and the seeded `initialOffset` wins.

This was source-verified on 3.16.1 in the v0.7 spike and **re-verified on the shipped
3.17.3** two ways: (1) the guard above still reads `this.scrollElement !== null` at
`index.js:288`; (2) the two-launch restore smoke `scripts/feed-scroll-restore-smoke.mjs`
(`pnpm smoke:feed-restore`, committed `90f3eeb`) drives a real Chromium layout across two
launches sharing one profile: Launch 1 scrolls to ~40% down (mid-feed), persists, and
closes; Launch 2 boots on the same profile and asserts (a) the restored top-visible note
is the SAME note (within one row of the legitimate estimate→measured shift) and (b) the
restored position is more than a full viewport from the bottom — i.e. `initialOffset` took
and `anchorTo:'end'` did NOT override it. A teeth-control profile with the same notes but
NO persisted scroll lands at the bottom on a later note, proving the assertions bite.
See ADR 0054 for the virtual-core 3.16.1→3.17.3 bump rationale.

`Feed` additionally drops `anchorTo` to `'start'` during sends/waves/glides via a
`suppressFollow` flag (`Feed.tsx:477`, `:528`), unrelated to boot restore but part of the
same options gating.

## Alternatives

- **Persist a bare `scrollTop` and set it in a post-mount effect.** Rejected as the
  primary path: the feed paints at the bottom first, then reflows/flashes to the saved
  position, and the set fights the end-anchor re-pin. The whole point of the
  measurements-cache seed is that it is applied *at* first render, flash-free.
- **Always `scrollToIndex` the anchor instead of the measurements-cache seed.** Rejected
  as the primary — `scrollToIndex` re-measures on the way and is not pixel-exact. It is
  kept as the FALLBACK (`mode: 'index'`) for when persisted indices no longer map to the
  same note ids (notes added/removed between sessions); the seed is the flash-free primary
  when indices still match (`pickFeedRestore` / `Feed.tsx:696`).

## Consequences

- **The two-launch smoke is the only real-layout regression gate.** happy-dom has no
  layout engine, so the Vitest/RTL suite cannot verify scroll restore at all;
  `scripts/feed-scroll-restore-smoke.mjs` is the sole end-to-end round-trip check. A future
  virtual-core bump **must** re-run it (the anchor analysis above is version-specific —
  it depends on `setOptions` gating the end-anchor re-scroll on `scrollElement !== null`).
- **The persisted position trails the live position by up to the throttle window** (~200ms)
  plus the writer debounce (250ms) — capture is trailing-throttled, so a very fast scroll
  persists where it *lands*, but the last ~200ms of movement before a hard kill may be lost.
- **`Feed`'s notes-present first-mount gate is load-bearing**, not incidental — it is the
  precondition for the seed being read at all. It is documented at the mount site
  (`App.tsx:1351-1359`) so it is not "simplified" away.

## Sources

- `src/renderer/src/feed/feedScrollRestore.ts:14-23` — `pickFeedRestore`
  (null→default / atEnd→bottom / indices-match→seed / anchor→index / else default).
- `src/renderer/src/feed/Feed.tsx:484-491` (render-body `fr`), `:537-539` (conditional
  seed spread), `:693-698` (one-shot restore layout effect), `:102`/`:732-764` (throttled
  `takeSnapshot` capture + true top-visible anchor), `:477`/`:528` (`suppressFollow`).
- `src/renderer/src/App.tsx:1351-1359`/`:1360`/`:1374-1409` — the `snapSettled` +
  notes-present first-mount gate; `:1382-1383` — `restore` / `onCapture` wiring.
- `node_modules/@tanstack/virtual-core@3.17.3/dist/esm/index.js:288` — the end-anchor
  `setOptions` branch gated on `this.scrollElement !== null`; `:167`/`:379` (init null),
  `:389-396` (assigned in the post-render effect).
- `scripts/feed-scroll-restore-smoke.mjs` — two-launch shared-profile restore round-trip,
  `pnpm smoke:feed-restore`, committed `90f3eeb`.
- `adrs/0054-virtual-core-3.17-bump.md` — the 3.16.1→3.17.3 bump this restore builds on;
  TanStack/virtual PRs #1199 / #1209 / #1212 cited there.
- `adrs/0005-tanstack-virtual.md` — the original end-anchored virtualizer.
- `adrs/0053-session-persistence-app-settings.md` — the `app_settings` mechanism that
  stores `feed.scroll.v1`.
