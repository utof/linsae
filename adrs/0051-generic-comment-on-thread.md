# 0051 — Generic `comment-on` thread: any note is a thread root

Status: accepted (v0.6.4)

## Context

v0.2 introduced the `comment-on` thread primitive:
`links(edge_type='comment-on', from_note_id=child.id, to_slug=parent.slug)`. At that
time the only thread root was a YouTube video note, so both the query layer and the UI
were YouTube-shaped:

- **`commentsForVideo(videoSlug)`** — a named IPC handler assuming a video slug.
- **`ThreadView`** — rendered a video player at the top, a video-order rail (timestamp
  sort), a capture-order toggle, and annotations as `<NoteBubble>` children. None of
  this generalized to a plain note or a PDF document.

v0.6.4 requires that *any* note — a `claim`, a `question`, or a `source` note for a
PDF — exposes an "open thread" affordance whose thread renders as a chronological list
of `comment-on` children with a composer. The YouTube video thread must continue to
work. The implementation must not duplicate the thread component tree.

## Decision

**Generalize the query layer and the UI. Branch inside one `ThreadView` on the root
note's `source_kind`; do not create parallel components.**

### Query layer

`commentsForVideo(videoSlug)` is renamed to `commentsForNote(slug)`. The underlying
SQL is unchanged — it was always slug-generic, only the name was video-specific. All
call sites updated. No IPC contract break (the channel name follows the function rename;
this is an internal IPC channel, not a public API).

### UI — two renderings, one component

`ThreadView` receives the root note and branches on `root.source_kind`:

- **`source_kind='youtube'`** — existing rendering: player header (now from the dock
  pane — ADR 0049), video-order rail + capture-order sort toggle, `NoteBubble` list.
  Functionally unchanged; visual composition changes because the player is now docked
  rather than embedded.
- **All other `source_kind` values (plain, `'pdf'`, etc.)** — new chronological
  rendering: `<ThreadRoot>` header (shows the root note's title and body, collapsed to
  a single line with expand affordance), `NoteBubble` child list (chronological,
  real wikilink navigation), `<SimpleComposer>` at the bottom.

### `ThreadRoot`

A new minimal header component (`src/renderer/src/thread/ThreadRoot.tsx`) renders the
root note's `deriveTitle` + truncated body, an expand/collapse affordance, and the
wikilink-navigate button. It is the visual anchor that orients the user ("you are
reading the thread of: *note title*").

### `SimpleComposer`

A new minimal composer (`src/renderer/src/thread/SimpleComposer.tsx`) with Enter-sends
behavior (consistent with the main note composer — ADR 0001). No media chrome (no
video timestamp, no screenshot capture). On submit it calls `notes:create` + the
existing `links:setCommentOn` IPC to post a `comment-on` child.

### "Open thread" affordance on every note

Every feed bubble and every canvas card exposes an "open thread" button (a minimal
icon, quiet hover-reveal). Activating it sets `threadNoteId` in `App`, which — under
the ADR 0048 sub-view model — causes `<main>` to render `<ThreadView>` for that note.

### Excerpts as `comment-on` children

PDF excerpt notes (created by `PdfReader.tsx` on text selection + drop/commit) are
posted as `comment-on` children of the document note (ADR 0050). The canvas-placement
path is preserved: if the user drops the excerpt ghost onto the canvas a
`node_layouts` row is created; if they do not, the excerpt still lands in the thread
as a child note. Both operations may happen for the same excerpt.

## Alternatives

- **Separate `PdfThreadView` alongside `ThreadView`** — rejected. The children are the
  same data (`commentsForNote` returns the same row shape regardless of parent
  `source_kind`), and the composer is the same (`SimpleComposer`). A parallel component
  would duplicate the child list, the scroll container, the motion guardrail (ADR 0019),
  and the `NoteBubble` usage — with no behavioral difference. Branching inside one
  component is strictly less code and less divergence risk.

- **Keep `commentsForVideo` as the only query** — rejected. The name embeds a
  YouTube assumption that would need to be unlearned at every future call site. Renaming
  to `commentsForNote` is a one-time, low-risk change that makes the API honest.

- **New `comment-on` edge type for non-video children** — rejected. Using the same
  `edge_type='comment-on'` for all thread children (YouTube annotations, PDF excerpts,
  plain replies) is the correct generalization. A second edge type would fragment the
  query and require two queries to build a thread, with no product benefit.

## Consequences

- **Any note is a thread.** A plain `claim` note, a `question`, a PDF document, a
  YouTube video — all expose the "open thread" affordance and render in `ThreadView`
  (branching on `source_kind`).
- **YouTube thread is unchanged in behavior.** The branch on `source_kind='youtube'`
  preserves the existing video-order rail and sort toggle. The visual difference is
  that the player is now in the dock (ADR 0049), not embedded in the view header.
- **Known follow-ups:**
  - Thread child bubbles (`NoteBubble`) expose edit and delete controls that are not
    yet wired for the thread context — tracked as issue #162.
  - `SimpleComposer` discards unsent text if the thread-create IPC call fails — tracked
    as issue #161 (p1, data-loss risk).
- **Nested-canvas rendering is deferred.** `canvas-vision.md` §Threads describes two
  renderings: chronological thread (this ADR) and nested canvas (`canvas_id = note.id`,
  principle 3). The nested-canvas rendering is out of scope for v0.6.4; only the
  chronological rendering ships.

## Sources

- Commit `6fe0968` — "rename commentsForVideo → commentsForNote (slug-generic)"
- Commit `a488fe5` — "SimpleComposer — Enter-sends text-only thread composer (B2)"
- Commit `6bd49eb` — "ThreadRoot header for plain-note threads (B2)"
- Commit `4262403` — "generic chronological ThreadView for plain/pdf notes (B2)"
- Commit `994ef72` — "open-thread affordance on every note (B2)"
- `docs/specs/v0.6.4-notes-as-threads.md` §Generic ThreadView; §The model
- `adrs/0001-enter-key-sends.md` — Enter-sends convention `SimpleComposer` follows
- Issue #161 — SimpleComposer data-loss on failed create (p1)
- Issue #162 — thread child edit/delete controls unimplemented
