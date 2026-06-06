# 0018 — Send animation via a position:fixed ghost clone

Status: accepted (v0.2.1)

## Context

Sending a note from the create-mode composer should feel like iMessage: the
bubble "lifts off" from the composer and flies up to its landing spot at the
bottom of the rolling feed. Two facts about linsae make the obvious "just
animate the new bubble" approach hard:

1. The feed is virtualized (`@tanstack/react-virtual`, `anchorTo:'end'`). Each
   item is absolutely positioned inside a `transform: translateY(start)` wrapper
   (`Feed.tsx`). Layering another transform on the real item fights the
   virtualizer's own.
2. The note is created **asynchronously**: `createMut` → IPC → better-sqlite3 →
   query invalidate → refetch (`App.tsx:175`). At the frame the user hits send,
   the destination note does not exist in the DOM yet; when it does, it may be
   re-keyed/re-measured by the virtualizer.

We also already have a synchronized rAF morph pipeline (`useExpandCollapseMorph`,
ADR 0007) whose easing/reduced-motion/`__morphSlow` idioms are worth reusing.

## Decision

Animate a **transient `position:fixed` ghost clone**, not the real item:

- `SendGhost` is a presentational note-**bubble** clone (matches `NoteBubble`'s
  box: 560 max-width, radius 14, padding 6/12 — NOT the wider composer card),
  rendered via `createPortal(..., document.body)` so it escapes any transformed
  ancestor (the same hazard `ContextMenu.tsx` escapes; the app shell currently
  has no transformed ancestor — verified in spec review).
- `useSendAnimation` reads the composer card rect **synchronously at submit**
  (before the success-driven remount can move it), mounts the ghost there, and
  drives `transform`/`opacity` from one rAF clock using the pure, tested
  `sendAnimationGeometry` (`sendTarget`/`sendFrame`/`SEND_EASE`).
- **Optimistic launch**: the ghost flies at submit, not on `onSuccess`. Local
  IPC+SQLite is fast, but a several-ms gate would read as lag. If `createMut`
  rejects (e.g. duplicate slug), the ghost simply completes its flight and
  fades — the existing red-error composer state is the source of truth; no
  recall/undo logic.
- **Overshoot is allowed** here (`cubic-bezier(0.34,1.56,0.64,1)`, the
  scrollbar-thumb / resize-handle spring), unlike ADR 0007's monotonic
  constraint.
- Verification is numeric, not visual: `scripts/send-harness.mjs` samples the
  ghost's per-frame rect/opacity and reports landing drift vs the real note.

## Alternatives

- **Animate the real virtualized item.** Rejected: must wait for the async
  create to resolve (no instant liftoff) and fights the virtualizer's
  `translateY` transform (context #1/#2 above).
- **CSS View Transitions API (`document.startViewTransition`).** Available —
  Electron 39 ships Chromium 142. Rejected: it freezes rendering during the
  DOM-update callback and the documented best practice is to finish async/network
  work *before* calling it, which collides with our async create path; and it
  would still snapshot the virtualizer's `translateY` item as
  `::view-transition-new`, re-introducing the very transform conflict the ghost
  avoids.
- **Launch on `onSuccess` instead of optimistically.** Rejected: adds a
  perceptible gate before liftoff for the common (success) case; the failure
  case is already communicated by the composer's red-error state.
- **Overshoot forbidden (mirror ADR 0007).** Not needed: ADR 0007's monotonic
  rule exists because an overshooting *clip box* exceeds its content and
  resurrects the empty-box blank inside a scroll-anchored item. A `transform` on
  a `position:fixed` div has neither a clip nor scroll coupling, so the spring
  bounce is safe.

## Consequences

- Animation is fully decoupled from IPC/DB latency and the virtualizer; the
  ghost can be tested and tuned independently of note creation.
- The ghost clones the *bubble*, so the landing pixel-matches the real note; the
  small width/shape snap happens at *liftoff* over the clearing composer, where
  the eye hasn't settled.
- `feedContentLeft` is approximated as the scroller's left edge; horizontal
  landing drift is left for the harness to confirm (it asserts Δleft). If the
  harness shows visible drift, the deferred follow-ups (async
  reconcile-to-real-item, grow-to-make-room) are the next levers — both
  explicitly out of v1 scope.
- Reduced motion (`prefers-reduced-motion: reduce`) and the first-ever send (no
  `<Feed>` mounted) both skip the fly with no ghost.
- New surface is additive: two optional props (`Composer.cardRef`,
  `Feed.scrollerRef`) and the new hook/component/geometry modules. No schema,
  migration, or dependency change.

## Sources

- ADR 0007 (`adrs/0007-animate-virtual-item-resize.md`) — the monotonic-clip
  constraint this ADR contrasts with.
- ADR 0004 — scroller ref-identity stability (why `Feed.handleScrollerRef` stays
  `useCallback([])` when merging the external `scrollerRef`).
- `docs/specs/v0.2.1-send-animation.md` — the reviewed spec.
- View Transitions: https://developer.chrome.com/docs/web-platform/view-transitions/same-document
- Electron 39 / Chromium 142: https://www.electronjs.org/blog/electron-39-0
