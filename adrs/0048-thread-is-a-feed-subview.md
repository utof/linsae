# 0048 — Thread is a feed sub-view inside `<main>`, not a peer stage

Status: accepted (v0.6.4)

## Context

Through v0.6.3, `ThreadView` was mounted at the *body-row* level — the same level as
the docks and the center stage. The conditional was:

```
{threadNoteId
  ? <ThreadView />
  : <><DockHost side="left" /><main>…</main><DockHost side="right" /></>}
```

When a thread was opened, both `DockHost` instances unmounted entirely. This made
"keep the PDF reader docked while reading a thread" impossible: the document you were
annotating closed the moment you opened its thread. The same teardown hit the YouTube
player, the shelf, and every other dock content.

The v0.6.4 spec (`docs/specs/v0.6.4-notes-as-threads.md`) requires that an excerpt
drag from the PDF reader onto the canvas remains reachable while the same PDF's thread
is open — the two must coexist, not alternate. At the same time, `canvas-vision.md`
principle 8 fixes exactly two peer full-window stage views (`feed` and `canvas`);
adding a third (`thread`) would require a third segment in the `feed | canvas`
segmented control and a `mod+3` hotkey — scope the spec explicitly ruled out.

## Decision

**The thread state lives entirely inside `<main>`, as a branch of the feed view.**
`App.tsx` renders docks unconditionally and hosts one `AnimatePresence` inside `<main>`
with three keyed children: `canvas`, `thread`, and `feed`, evaluated in priority order
(canvas > thread > feed). When `threadNoteId` is non-null and the canvas is not active,
the `thread` child renders `<ThreadView>`; the docks, `StatusBar`, and all window chrome
remain mounted throughout.

No third segment is added to the `feed | canvas` control in `WindowFrame.tsx`. No
`mod+3` hotkey is introduced. `canvas-vision.md` principle 8 is upheld without
amendment.

`threadNoteId` is stored in a `useState` inside `App`; because it is inside `<main>`
rather than branching above the docks, it persists naturally across a `feed ⇄ canvas`
toggle — flipping to the canvas collapses the thread view, but the state survives so
returning to the feed re-opens it.

## Alternatives

- **Thread as a third peer stage view** — rejected. Adding `thread` as a sibling of
  `feed` and `canvas` at the body-row level requires amending `canvas-vision.md`
  principle 8 ("two peer full-window stage views"). It also forces a third segment
  and a `mod+3` hotkey, adding window chrome the spec explicitly excluded.

- **Keep the old branch but remount docks on both arms** — considered. Duplicating
  `<DockHost>` in both branches of the conditional keeps the body-row structure but
  means the dock store, pane content, and any transient state (scroll positions, player
  progress) must survive the unmount/remount. This is fragile and contradicts the dock
  shell's in-memory model (ADR 0045 — no persistence, state lives in the store).
  The sub-view approach is simpler: docks never unmount.

## Consequences

- **Docks coexist with an open thread.** The PDF reader, YouTube player dock pane,
  shelf, and backlinks panel all remain mounted while a thread is visible — exactly the
  stated goal.
- **`threadNoteId` survives `feed ⇄ canvas` toggle.** It is a behavior change from
  v0.6.3: in the old model, navigating away from the feed closed the thread implicitly.
  Now returning to the feed re-opens the last thread.
- **`StatusBar` and all window-level chrome are always visible.** No stage transition
  hides or re-mounts them.
- **Animation contract:** the three-key `AnimatePresence` inside `<main>` means thread
  open/close animates as a within-`<main>` slide, distinct from the body-level
  `feed ⇄ canvas` slide. Motion guardrail from ADR 0019 (no `layout`/`layoutId` inside
  the virtualized feed) is unaffected — the feed is unmounted when the thread key is
  active.

## Sources

- Commit `503cdbd` — "thread is a feed sub-state of \<main\> so docks coexist (B1)"
- `docs/specs/v0.6.4-notes-as-threads.md` §The model; §Non-goals (no third stage view)
- `docs/canvas-vision.md` principle 8 (two peer full-window stage views)
- `adrs/0045-dock-ordered-panes-zustand.md` — dock store in-memory model this preserves
