# 0019 — Motion (`motion/react`) as the animation library

Status: accepted (v0.2.1)

## Context

We want a lot of polished UI animation across the app — spring-y checkboxes,
drag interactions, toggles, modal/toast enter-exit, button press feedback — and
we want the *feel* to be good, not just present.

Today every animation is a bespoke `requestAnimationFrame` loop:

- `useExpandCollapseMorph` (ADR 0007) — the note expand/collapse roll.
- `useSendAnimation` + `sendAnimationGeometry` (ADR 0018) — the send ghost.

Each took real effort, its own easing curve, and (for the ghost) a dedicated
Playwright harness to verify. That does not scale to "a lot of fancy
animations," and the easing is hard-coded (a `cubic-bezier`), so the feel is
fixed rather than physical.

Before adopting anything we surveyed the prior art (a research subagent +
direct issue reads — captured verbatim in
`docs/research/v0.2.1-send-animation-prior-art.md`). Two findings drove this
decision:

1. **No off-the-shelf library does our hardest case** — flying an element into a
   *new, async-arriving* item inside a *virtualized, transform-positioned* list.
   Every shared-element/FLIP tool (Motion `layoutId`, react-flip-toolkit, GSAP
   Flip, View Transitions) needs the destination node to exist at animation
   time; ours arrives after IPC → SQLite → refetch. A real user hit exactly the
   Framer-Motion-on-`@tanstack/react-virtual` new-item failure in TanStack
   virtual #693. So the send ghost stays hand-rolled (ADR 0018).
2. **For everything else, a spring library is the standard** — and the
   instability reports against Motion are confined to its `layout`/`layoutId`
   *shared-element projection* subsystem, not its gesture/spring core.

## Decision

Adopt **`motion`** (the renamed `framer-motion`), imported as `motion/react`, as
the primary animation library for discrete UI interactions. Drive feed-internal
animations with its framework-agnostic imperative `animate()`.

Guardrails (these are load-bearing — violating them reintroduces known bugs):

- **No `layout` / `layoutId` shared-element projection inside the
  `@tanstack/react-virtual` feed.** The feed's rows are positioned with
  `transform: translateY(...)`; Motion's projection re-measures and applies
  counter-transforms each frame and fights that, and it silently no-ops on
  async-inserted rows (TanStack virtual #693). Feed-internal motion
  (expand/collapse morph, append make-room reveal) animates `scrollTop` / clip
  height imperatively, never via layout projection.
- **If a Motion `layoutId` element is ever portaled, reset or forward
  `MotionContext`** across the portal boundary (motion #1524) — a portal splits
  the React tree from the DOM tree, so the portaled node reads the wrong motion
  context and the animation snaps start→end with no interpolation.
- **Never put enter/exit `variants` on a `layoutId` node** (motion #2111) — it
  produces position jumpiness; animate a wrapper instead.
- **Respect `prefers-reduced-motion`** (`useReducedMotion()` or the existing
  `matchMedia` check) on every animation, as the rAF systems already do.

The first Motion usage is the feed **append make-room reveal** (the new note
slides up into its slot instead of popping in) — see
`docs/specs/v0.2.1-send-animation.md`.

## Alternatives

- **React Spring (`@react-spring/web`) + `@use-gesture/react`.** Lower-level,
  physics-first, exact mass/tension/friction control, but more verbose and a
  steeper API. Kept as the escape hatch for a specific micro-interaction whose
  feel Motion can't hit — not the default, because Motion's spring defaults are
  good and its gesture props (`whileTap`/`whileHover`/`drag`) make the common
  cases one line.
- **Keep hand-rolling rAF.** Rejected as the default: doesn't scale to many
  interactions, hard-codes easing, and each needs its own harness. The two
  existing rAF systems stay for now and may migrate opportunistically.
- **FormKit AutoAnimate.** Rejected: animates only the direct children of one
  parent on add/remove/move; no cross-container, declines "animate across
  lists," and breaks on transformed/not-initially-rendered containers.
- **CSS View Transitions API.** Already rejected in ADR 0018 for the send case
  (freezes during the async DOM-update callback, snapshots the virtualizer's
  `translateY` row) — same disqualifier applies to feed transitions generally.

## Consequences

- One new dependency (`motion`, ~12.x). Bundle cost is a non-issue in Electron —
  the app ships locally, there is no download to pay for — and Motion is
  tree-shakeable via `LazyMotion` if that ever changes.
- Motion v12 supports React 19 concurrent rendering and the React Compiler
  (already in `devDependencies` as `babel-plugin-react-compiler`) can auto-memoize
  its components.
- The two existing rAF systems (`useExpandCollapseMorph`, `useSendAnimation`)
  are untouched by this ADR; follow-up refactors may port them to Motion's
  imperative `animate()` where it reduces complexity, in their own commits.
- The "no `layout`/`layoutId` in the feed" guardrail must be honored by every
  future contributor (human or agent) or TanStack #693 returns. This ADR is the
  written record so it isn't rediscovered the hard way.

## Sources

- Prior-art survey (verbatim): `docs/research/v0.2.1-send-animation-prior-art.md`
- Motion for React docs: https://motion.dev/docs/react
- Motion layout-animation caveats: https://motion.dev/docs/react-layout-animations
- motion #1524 — shared layout animations break in a React portal (closed; community workaround: reset/forward `MotionContext`): https://github.com/motiondivision/motion/issues/1524
- motion #2111 — `layoutScroll` + shared layout (closed-as-stale; cause was variants on a `layoutId` node): https://github.com/motiondivision/motion/issues/2111
- TanStack virtual #693 — Framer Motion new-item animation fails in a virtualized list: https://github.com/TanStack/virtual/discussions/693
- Drag-and-drop prior art converging on the portal-to-body clone (corroborates ADR 0018): Angular CDK https://angular.dev/guide/drag-drop · dnd-kit `DragOverlay` https://docs.dndkit.com/api-documentation/draggable/drag-overlay · Elastic UI https://eui.elastic.co/docs/components/display/drag-and-drop/
- ADR 0007 (`adrs/0007-animate-virtual-item-resize.md`) — the scrollTop-driving pattern the make-room reveal mirrors.
- ADR 0018 (`adrs/0018-send-ghost-clone.md`) — why the send ghost stays hand-rolled.
