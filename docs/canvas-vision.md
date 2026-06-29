# Canvas vision — the map, not the contract

**Status:** living document. Direction here is binding; *order* is not (see §Sequencing). Acceptance
criteria live in per-milestone specs (`docs/specs/v0.x-*.md`); when this doc and a spec disagree
about the present, the spec wins — when they disagree about the future, this doc wins until amended.

**Who reads this:** the orchestrator, and every spec/plan reviewer (review prompts must say "check
the spec's Future-contracts section against `docs/canvas-vision.md`"). Implementers don't need it —
by the time work reaches them, the relevant futures are concrete interfaces in a plan.

**Evidence basis:** `docs/research/2026-06-11-canvas-architecture-synthesis-v2.md` (architecture +
prior-art synthesis) and `docs/research/2026-06-12-canvas-spike-results.md` (Stage-0 measured
numbers; single hardware point — Quadro RTX 3000, 60Hz, dpr=1 — thresholds re-check on any other
target machine). Product decisions 2026-06-12/13 brainstorm + wireframe sessions.

## Product thesis

The canvas is a **thinking space**, not a graph visualization. The user's spatial memory does the
organizing: notes are placed by hand, stay where they were put, and the surface is curated — it
shows only what was deliberately placed on it. This follows the strongest research finding: tools
whose spatial surfaces people live in (Heptabase, Scapple, Tinderbox, MarginNote, Muse) are
manual-placement-first; force-directed whole-vault graphs (Obsidian, Roam) start degrading around
~200 notes and are reliably hairballs by ~500 (community-reported, not benchmarked). Auto-layout
exists only as on-demand, local, undoable *commands* — never as the default arrangement.

The long arc: one surface that zooms semantically from readable markdown cards, through title
pills, down to a whole-vault dot field at far zoom — overview first, zoom and filter, details on
demand. The far-zoom dot tier eventually takes the "where is everything" job (it is the minimap;
a separate minimap widget is permanently ruled out).

## Locked principles (cross-milestone, durable)

1. **Notes are live references.** A card on the canvas is the same note as the feed bubble — one
   row, two projections, edited from either. The ▦ "placed" chip is the legibility device for this
   everywhere a note is listed (feed, pickers, shelf).
2. **Position is view-state.** Spatial data lives in `node_layouts` (table lands with the v0.4
   migration), never on the note. Spatial undo is a separate delta stack from content undo.
3. **`canvas_id` is an opaque text key. There is no canvases table.** It is `'root'` today; when
   threads arrive it becomes the parent note's id — a note's thread *is* its canvas, one identity.
   (One known seam: `comment-on` edges target the parent's *slug* while `canvas_id` will be its
   *id*; the slug↔id join and slug renames are a small real sync surface to handle in the threads
   spec.)
4. **`arrangement_id` is a dormant key** on `node_layouts` (only `'manual'` rows exist). Computed
   layouts ship as commands that *mutate* the manual arrangement; parallel switchable arrangements
   stay out of the product unless dogfooding demands them (issue #96 holds the revisit trigger).
5. **Hybrid renderer.** DOM cards near (1:1 scale at rest, translate-driven), a canvas-2D underlay
   beneath them sharing the world transform (edges, dots, later strokes). Viewport culling via
   rbush is the chosen mitigation — but note the spike graded cull **NEAR-PASS**, not pass
   (mean 51–56 fps, p95 = 33 ms on card-mount churn), so every card-tier milestone owes a
   mount-churn amortization decision (idle prebuild / KaTeX render cache / motion-LOD placeholder
   — the v0.4 spec makes the first call). `content-visibility` is retired for transformed canvas
   contexts (spike: actively harmful, 11–15 fps). WebGL only if a measured scale ceiling forces
   it.
6. **Curated start.** The root canvas begins empty; nothing is auto-seeded. Whole-vault projection
   belongs to the far-zoom dot tier, not to card-tier auto-scatter.
7. **Constrained tiling is the window grammar** (see §Dock shell): left dock / center stage / right
   dock, tabs as text labels, conditional tab strips, home-dock defaults, drag-to-rearrange as a
   pure power feature. Pay-as-you-go chrome: a user who never opens a second pane never sees a tab.
8. **Entry doors.** The shipped primary door is the Feed|Canvas toggle — two peer full-window
   stage views. Two more doors are decided-but-future and *compose* with it rather than replace
   it: per-note "open on canvas" (enter centered on a focal note) and a feed|canvas split pane
   (needs the dock shell to express it). The toggle itself may be re-examined in the layout-shell
   experiments, but never at the cost of losing the two-peer-views model without amending this
   doc.
9. **Ink reuse contract (§4a of the synthesis doc):** the canvas imports the Stroke-geometry layer
   (`InkPoint`/`Stroke`/`strokeToPath`, vendored `getSvgPathFromStroke`) and never the screenshot
   `Scene{width,height}` envelope. Points are truth, outlines are derived; the canvas adds its own
   SQLite blob serializer.
10. **v21 design system** is visual ground truth. Canvas chrome is quiet: status bar as the
    command strip, no toolbars, no icon rails.

## Now

**Latest shipped: v0.6 pdf-slim-slice** (`docs/specs/v0.6-pdf-slim-slice.md`) — a PDF opens in a
right-dock content pane beside the canvas; read + select + **excerpt-drag onto the canvas**. It grew
the dock-shell embryo a **right dock + content-pane class** (`Pane.kind`, `Dock.side`) but **no tabs,
no multi-pane** (2026-06-28 amendment, §Sequencing). Current branch `v0.6.1/electron-bump` is an
Electron 39→42 patch — no product surface.

**Now building: §Dock shell — v0.6.2 dock-shell** (`docs/specs/v0.6.2-dock-shell.md`; implemented on
`v0.6.2/dock-shell`, awaiting merge after v0.6.1). It "backs up" the slim PDF slice with the real
multi-pane grammar: a dock = ordered pane ids + active id in an in-memory zustand `dockStore`; **tab
strips render once 2+ panes share a dock**; **backlinks becomes the first right-dock utility pane**
(dual surface — the transient focus overlay is kept AND a deliberately-opened dock pane is added).
What remains **deferred**: cross-dock **tab dragging**, the two quiet dock-toggle chrome affordances,
left-dock multi-pane / shelf tab-mates, the AI-chat pane, and dock-layout persistence — all additive
seams on the ordered-list model.

## Future backlog (unordered)

Each item is self-contained so the list can be reshuffled without rewriting it. None of these are
commitments to a date or an order; all of them are commitments to a *direction* — a v0.x spec that
forecloses one of these must amend this doc first.

### Dock shell (full constrained tiling) — embryo v0.4/v0.6; **grammar ✅ shipped v0.6.2** (`docs/specs/v0.6.2-dock-shell.md`); cross-dock drag + toggle chrome deferred
The embryo — the `Pane` registry + left dock (shelf) from v0.4, plus (since **v0.6**) a **right dock +
content-pane class** (`Pane.kind: 'utility' | 'content'`, `Dock.side`) holding one PDF beside the
canvas — grew into the full grammar in **v0.6.2 dock-shell**: a dock = ordered pane ids + active id in
an in-memory zustand `dockStore`; **tab strips that render only at ≥2 panes** (`DockTabs`); every pane
has a home dock and opens there by default (note-list things → left; contextual utilities → right;
content panes → right, wide) — **backlinks is the first right-dock utility pane**, with a dual surface
(kept overlay + deliberate dock pane). Still **deferred**: tab dragging between docks as pure
rearrangement, never a flow step; two quiet outline dock-toggles at top-right, and no other window
chrome — resist the feature-button row. Two
pane classes, one mechanism: **content panes** (PDF, video — want width, peers of the canvas, probably
max one visible per dock) vs **utility panes** (shelf, backlinks, AI chat — narrow, cheap). The v0.6
PDF pane is the **first content pane and first right-dock pane**, so this milestone *generalizes* an
existing pattern rather than inventing it; the remaining forcing functions are **backlinks + AI-chat
utility panes** and **≥2 panes coexisting in one dock** — the moment tab strips, multi-pane, and the
home-dock defaults all become real. Escape hatch if dogfooding shows shelf and feed must be visible
simultaneously: allow one dock to split horizontally — note this presupposes feed-as-a-pane, which
otherwise only arrives with channels, so taking the hatch means pulling feed-as-pane forward
deliberately, not as a side effect. Do not build the rest until proven. All layout state is per-window
view-state; no saved workspaces/presets until layouts demonstrably hurt to reconstruct.

### Semantic zoom, shipped for real
User-facing title tier and dot tier on the underlay: zoom-threshold UX, card⇄title⇄dot transitions
(semantic-consistency invariant: anything visible at a tier persists at all deeper tiers), dot
hit-testing with inflated radius + snap-to-nearest, labels on hover/proximity at dot zoom. The dot
tier doubles as the minimap and as the whole-vault lens (notes without manual positions get
computed positions *here*, not on the card tier) — this is where issue #96's overview direction
lands if its trigger fires. Spike says canvas-2D handles 10k dots at 60 fps; WebGL not needed at
this scale.

### Layout engine (research Stage 2)
Worker-based simulation honoring the d3-force `tick()`/`stop()` contract; positions in a
`Float32Array` (transferables first, SharedArrayBuffer only if measured need); main thread
interpolates. Delivers **arrangement commands**: arrange-selection-as-timeline / tidy-tree / grid,
seed-scatter for a shelf batch — all local, on-demand, undoable mutations of the manual
arrangement. Relayout animates as one staged eased tween (freeze input → snapshot → compute →
interpolate positions, edges following → settle); never unmount/remount mid-tween.

### Edge work (creation + interaction) — ✅ shipped v0.4.1 (`docs/specs/v0.4.1-canvas-edges.md`)
v0.4 ships read-only edge *display*. This milestone adds: drag card→card to create a typed link,
type picker, edge selection/deletion, possibly labels; line hit-testing on the underlay. Edge
creation writes real `links` rows — it is a data operation with canvas affordances, same
live-reference philosophy as cards. **Constraint discovered in review:** `replaceLinksForNote`
deletes all `edge_type='reference'` rows on every note save and reinserts only body-derived
wikilinks — a canvas-created edge stored as `'reference'` would be silently wiped on the next
save. Canvas-created edges must use a distinct edge type (or renegotiate the replace contract)
— same trap the v0.2 `comment-on` work already hit once.

### Canvas ink (research Stage 3)
The §4a remaining-work list (paraphrased; §4a is authoritative): (1) far-zoom stroke renderer on
the underlay (SVG is fine at card zoom, wrong at dot zoom); (2) SQLite points-blob serializer
(Float32 x/y/pressure) in a per-canvas `strokes` table keyed by `canvas_id`; (3) strokes enter
rbush and participate in culling; (4) stroke→node promotion (insert note + layout, attach stroke
ids). Product decision from the 2026-06 brainstorm (not in §4a): strokes belong to the manual
arrangement only — a recomputed arrangement must never orphan ink, which is one of the standing
arguments against switchable arrangements (#96). Implementation notes banked from the spike: on a synchronized 2D
context you MUST drain `getCoalescedEvents()` (7.44 samples/pointermove measured) or lose ~87% of
stroke fidelity; `desynchronized:true` engages on this stack and delivers full-rate events but is
not a perceptible latency win with a mouse — keep it as a free flag, don't rely on it. Watch the
known "hot elbows" artifact on fast strokes. Pen/stylus is untested to date.

### Threads + nested canvases
Any note can become a thread (its `comment-on` children — same mechanism as YouTube annotations).
A note with sub-notes gains a per-note toggle between two renderings: **node-with-children**
(children as satellite cards/dots around the parent on the current canvas) and **nested canvas**
(open the note *as* a canvas; `canvas_id` = that note's id activates principle 3, and every canvas
mechanism — shelf, camera, zero state, undo — is inherited). Open design questions to settle in
that spec: does a thread canvas get its own shelf; how does breadcrumb/zoom-out-to-parent
navigation work; how the toggle composes with the dot tier.

### Multiple canvases (top-level UI)
Create/name/switch/delete for additional root-level canvases. Positions are already keyed by
`canvas_id` (principle 3), but principle 3 also means there is no canvases table to hold a name —
so the likely resolution is that a top-level canvas is *itself a note* (its id is the `canvas_id`,
its title is the canvas name), exactly as thread canvases work; `'root'` stays the one anonymous
special case. Decide in that spec; do not introduce a canvases table without amending principle 3.
Interacts with channels (below) — a canvas may declare which feed it works with.

### Multiple feeds / channels
Telegram-style channels: several feeds, a feed picker as a left-dock pane, each canvas able to
choose its working feed from inside the canvas view (no round-trip through the feed view). This is
the moment the feed stops being singular app chrome and becomes a pane like everything else.

### PDFs (and the excerpt-drag move) — slim slice ✅ shipped v0.6 (`docs/specs/v0.6-pdf-slim-slice.md`)
PDF as a content pane in the right dock: read, annotate, and — the entire point — **drag an excerpt
onto the canvas** as a note carrying its source locator (the MarginNote move; same `source_locator`
philosophy as YouTube annotations). **Read + excerpt-drag shipped in v0.6** (no annotation); it grew
the right-dock content-pane embryo (see §Dock shell). What remains is the full milestone — **PDF
annotation (Stage 2)**, re-open-at-source navigation, image-region excerpts, multi-document tabs —
sequenced *after* the dock shell + canvas-ink Stage 3.

### Canvas layers
Z-layers within one canvas (show/hide/lock groups of content, ink on its own layer, etc.).
User-stated constraint: comes *after* PDFs. Nothing in current schema forecloses it; if a future
spec adds a column that would (e.g. baking z-order into note rows instead of layout rows), this
item is the tripwire.

### Full undo
Beyond v0.4's in-memory spatial stack: persisted history, redo tree, integration with content undo.
No design yet; the delta-stack separation (principle 2) is the foundation it builds on.

### Standing experiments / revisits (not milestones)
- **Issue #96** — switchable arrangements + whole-vault placement. Pre-registered trigger: after
  ~4 weeks of dogfooding v0.4, fewer than ~20 manually placed notes falsifies the thinking-space
  bet and promotes the overview/dot-first direction.
- **Layout-shell experiments** — niri-style infinite horizontal strip, removing the top
  Feed|Canvas toggle in favor of something more intuitive, dnd-kit-style dockable feed/canvas.
  The two future entry doors from principle 8 (per-note "open on canvas", feed|canvas split pane)
  land when the shell can express them; any toggle redesign is bounded by principle 8.
- **Esc-precedence audit** (#18) grows with every canvas mode (placement, picker, marquee,
  selection); re-audit each canvas milestone.

## Sequencing

Best-guess order, **non-binding**: dock shell → semantic zoom → layout engine → edge work → ink →
threads/nested → multi-canvas → channels → PDFs → layers. Any item may jump the queue (edge work
is the likeliest to move up). Exactly two ordering constraints are binding, both user-stated:
**PDFs only after the node/edge/tab/pane workflow is nailed**, and **layers only after PDFs**.
Resequencing = edit this section, nothing else.

> **Amendment (2026-06-28, v0.6):** the slim PDF slice (read + excerpt-drag, no annotation) was
> pulled forward ahead of the full dock shell as `v0.6/pdf-slim-slice`. It ships only the embryo
> right-dock + content-pane slice (`Pane.kind`, `Dock.side`) — NOT tabs, NOT multi-pane, NOT edge
> work. This honors "dock-shell design must protect the excerpt-drag path from day one." The full
> PDF milestone (annotation, Stage 2) remains sequenced after the dock shell + canvas-ink Stage 3.

> **Amendment (2026-06-29, v0.6.2):** the **dock-shell grammar** (multi-pane docks, tab strips at ≥2,
> the `dockStore` ordered-list model, backlinks as a dockable dual-surface pane) shipped as
> `v0.6.2/dock-shell` — the first item on the sequence is now largely done. What remains of §Dock shell
> is the deferred set (cross-dock tab dragging, dock-toggle chrome, left multi-pane, AI-chat pane,
> persistence). Next up the queue: **semantic zoom**.
> Layers remain after PDFs (full milestone).
