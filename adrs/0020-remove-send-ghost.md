# 0020 — Remove the send "ghost"; the note's own scroll-glide entrance IS the send animation

Status: accepted · Supersedes: [0018](0018-send-ghost-portal-clone.md)

## Context

ADR 0018 introduced a "ghost": a `position:fixed` portal clone of the about-to-be-sent
note that flies from the composer up to its landing slot, while the real (async-created)
note is held `opacity:0` until the ghost lands ("hide-until-landing"). The make-room half
(`useAppendReveal`) separately glides the feed up.

In practice this produced a visible bug and a pile of coupled machinery:

- **The clone overlaps real notes.** The ghost is opaque and pixel-identical to a note
  (deliberately — for "sameness"), so as it flies up it draws *on top of* the notes it
  passes, reading as a duplicate. Measured with `scripts/reveal-stress.mjs`: the ghost
  overlaps a note by ~250px for a normal multi-paragraph note and ~900px for a
  viewport-tall one. This is intrinsic to "opaque clone + a straight path across the
  stack", not tunable — taming the `easeOutBack` overshoot (2.6 → 0) left the overlap
  unchanged.
- **Three clocks coordinated by timing + `setTimeout` fail-safes** (flight 460ms / reveal
  400ms / hide-failsafe 900ms, each scaled by `__morphSlow`) — a fragility anti-pattern;
  the fail-safes exist precisely because the happy-path coordination isn't trustworthy.
- **A brittle hand-synced clone** (`SendGhost` re-implemented `NoteBubble`'s styling and a
  18-nbsp time reservation byte-for-byte; any restyle silently desyncs).

Two independent research passes plus an unbiased audit found the same thing: **no
production web chat flies an opaque clone over the feed.** The field default
(TanStack Virtual's own chat guide, GetStream's React SDK, `use-stick-to-bottom`) is to
mount the new message at full size and **spring the scroll**. The one app that does
"input morphs into the bubble" — Telegram — does it as a **short** morph into the
*adjacent* bottom slot, never a long traversal, so overlap barely arises.

## Decision

Delete the ghost subsystem (`useSendAnimation`, `SendGhost`, `sendAnimationGeometry`) and
the hide-until-landing state. The make-room scroll-glide (`useAppendReveal`) is now the
*entire* send animation: a newly-sent note mounts at full height and the feed animates
`scrollTop` so the note rises into view at the bottom. App keeps a `sendInFlight` flag
(set on submit, timeout-cleared) **only** to suppress the virtualizer's own auto-scroll
during the glide (the #66 white-wall guard) — it no longer drives any clone.

## Alternatives

- **Keep the ghost, make it non-overlapping** (translucent / arc path): band-aids the look
  but keeps all the coupling and still reads as a faint duplicate. Rejected.
- **Composer → bottom-bubble *short* morph** (Telegram's model): the desired "the composer
  becomes the note" flourish, with overlap structurally bounded by the short distance.
  This is the planned endgame; it builds cleanly on this scroll-glide foundation.
- **CSS View Transitions / FLIP on the real element**: FLIP is documented-broken for
  async-inserted virtualized rows (TanStack Virtual #693); View Transitions interact
  badly with the virtualizer's `translateY` rows. Deferred.

## Consequences

- The ~250–900px send-time bubble overlap is gone by construction (no clone exists).
- ~3 files + 3 tests + three coordinated timers + the pixel-synced clone are deleted; the
  send path is now one animation with one owner of the scroll.
- The "lifts off the composer and flies in" flourish is gone *for now*; it returns, done
  correctly (short, no overlap), with the composer→note morph endgame.
- `Composer.cardRef` is kept (currently unused) as the anchor for that morph.

## Sources

- `scripts/reveal-stress.mjs` (overlap + white-wall measurements; per-frame intersection gates).
- TanStack Virtual chat guide (https://tanstack.com/blog/tanstack-virtual-chat) — `followOnAppend`, no entrance-clone.
- `use-stick-to-bottom` (https://github.com/stackblitz-labs/use-stick-to-bottom) — velocity spring on scroll, no clone.
- GetStream `VirtualizedMessageList` (https://getstream.io/chat/docs/sdk/react/components/core-components/virtualized_list/) — `stickToBottomScrollBehavior`, no clone.
- Telegram send animation (https://telegram.org/blog/animated-backgrounds) — short composer→adjacent-bubble morph.
- TanStack Virtual #693 (https://github.com/TanStack/virtual/discussions/693) — FLIP fails on async-inserted virtualized rows.
