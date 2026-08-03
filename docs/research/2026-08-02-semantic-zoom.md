# Semantic zoom and LOD — research for the next canvas milestone

**Date:** 2026-08-02 · **Status:** research input, not a spec. Nothing here is binding; the spec that
follows decides.

**Method / provenance.** Primary sources were read directly wherever they exist: tldraw and
Excalidraw source pulled from GitHub (`gh api` / `raw.githubusercontent.com`, `main` branch, fetched
2026-08-02), MapLibre GL JS source likewise, the Cockburn/Karlson/Bederson ACM Computing Surveys
review and the Christensen/Marks/Shieber TOG paper read as extracted PDF text, W3C WCAG 2.2 read
from `w3.org`. Closed-source products (Figma, Miro, Heptabase, Muse, Kosmik, Scrintal, Milanote,
Prezi, Obsidian) have **no primary source** — those rows are marked as such and are the weakest
claims in this document. Every claim below is tagged **[verified]** (I read the source and quote it)
or **[inferred]** (my reasoning from verified facts).

**Repo state this was written against:** `main` @ `2915445`, `motion@12.40.0`, `react@19.2.6`,
`rbush@4.0.1`.

---

## Verdict

1. **The hysteresis question has an established answer, and it is not a Schmitt trigger.** Games use
   enter/exit hysteresis (DigitalRune's canonical example: threshold 100, hysteresis 10 → switch down
   at 105, up at 95). But the two 2D-canvas products that actually ship zoom-driven LOD both do
   something better suited to a wheel-driven camera: **tldraw freezes the zoom value that feeds LOD
   for the entire duration of a camera gesture** (`Editor.getDebouncedZoomLevel`, snapshot taken at
   idle→moving, released 64 ms after the last movement), and **tldraw's grid cross-fades over a wide
   band rather than switching at a point**. linsae already has the exact hook tldraw uses —
   `useCanvasCamera`'s `isMoving` / `SETTLE_MS = 120` (`src/renderer/src/canvas/useCanvasCamera.ts:29`,
   `:93-97`). Recommendation: freeze-during-gesture first; add hysteresis only if freeze alone is
   insufficient. §3.

2. **`will-change: transform` is the opposite case from `content-visibility`, and the spike's ban
   does not transfer to it.** Chrome ≥53 re-rasters every composited subtree whenever its transform
   *scale* changes, unless `will-change: transform` is set, which "forc[es] the content to be
   rastered into a fixed bitmap, which subsequently never changes under transform updates". linsae
   sets no `will-change` anywhere in the renderer (verified by grep), so every DOM card is being
   re-rastered on every zoom frame today. Chrome's own recommendation — "add `will-change: transform`
   when animations begin and remove it when they end" — maps 1:1 onto `isMoving`. §4.

3. **The dot tier's perf claim is real but narrower than `docs/canvas-vision.md:121` states.** The
   spike measured `fillRect(sx-1, sy-1, 2, 2)` with a per-dot screen-space cull, 10k points, at
   `baseZ 0.1` over a 10 000 × 6 600 field (`scripts/spike-canvas/page/dots.js:36-37,42`). It is
   evidence for *2 px axis-aligned rects*, not for arcs, not for labels, and not for text. linsae's
   own #124 measured a batched-arc variant at 5.4 fps / p95 533 ms — but that variant changed three
   things at once, so "batched `Path2D` is slow" is **not** established. tldraw's production minimap
   does batched `Path2D`-of-rects with the path cached across frames and two `ctx.fill()` calls per
   frame. §5, §Contradictions.

4. **The literature actively supports "the dot tier is the minimap; a separate minimap widget is
   ruled out"** (`docs/canvas-vision.md:28-29`). Hornbæk/Bederson/Plaisant (TOCHI 2002, as summarised
   in the Cockburn survey §7.2.2) found that **an overview+detail region *increased* task completion
   times when semantic zooming was enabled** — the overview was made redundant by the semantic
   detail — and §7.2.3 found spatial recall was *better* without the overview. The counterweight:
   users *preferred* having the overview despite being slower. §8.

5. **The semantic-consistency invariant, as written, is ambiguous in the direction that matters, and
   the 4-of-438 measurement makes the ambiguity load-bearing.** `src/renderer/src/canvas/lod.ts:4`
   says "anything visible at a tier persists at all deeper tiers". If "deeper" means *more zoomed
   in*, then putting 434 computed-position notes on the dot tier and nowhere else **violates the
   invariant on every zoom-in**. If "deeper" means *further out*, it is satisfiable but says almost
   nothing. The spec must pick a direction and say it in words, not in the word "deeper". §10.

6. **The title tier is the unmeasured risk, not the dot tier.** At zoom 0.15 a 1280 × 774 viewport
   covers ~8533 × 5160 world px — with a 438-note vault essentially every note is on screen, so the
   title tier's worst case is ~438 screen-constant `fillText` calls per frame. Nothing in the spike
   or the perf harness measured text at all (`docs/harness/canvas-perf.md` phases are churn / steady
   / dot). The standard mitigation is an offscreen-canvas / `ImageBitmap` label sprite cache +
   `drawImage`. §4.

7. **`motion`'s purpose-built representation-swap API is not usable here.** The React `<AnimateView>`
   component does not exist in the installed `motion@12.40.0` (verified: not exported). The
   imperative `animateView()` *is* exported — but it wraps the native View Transition API, which
   ADR 0018 already rejected for freezing during the async DOM-update callback. That is worse on a
   canvas mid-gesture, not better. Cross-fading two simultaneously-mounted representations with
   plain opacity is the answer. ADR 0019's `layout`/`layoutId` ban is textually scoped to the
   virtualized feed, but its stated *mechanism* — projection re-measures and applies counter-
   transforms each frame, fighting a transform-positioned parent — applies verbatim to a
   `translate(...) scale(...)` world container. §9.

8. **Still open after this research:** whether the dot tier should render all 438 notes or only
   placed ones (a product call, §10); the actual cost of ~438 `fillText`/frame on the reference
   machine (needs a spike, §4); whether hit-testing at dot tier should use `rbush-knn` (an
   unmaintained-since-2024 extra dep) or a hand-rolled nearest-scan over the inflated `search()`
   result (§6); and the exact hysteresis/fade-band numbers, which no source prescribes for a
   zoom-driven 2D UI (§3).

---

## Q1 — What "semantic zoom" canonically means

### Geometric vs semantic

The canonical distinction and its attribution, from the Cockburn/Karlson/Bederson survey
([ACM Computing Surveys 41(1), 2008](https://dl.acm.org/doi/10.1145/1456650.1456652), read from the
[Georgia Tech mirror](https://faculty.cc.gatech.edu/~stasko/7450/Papers/cockburn-surveys08.pdf),
p. 2:8, §4.2) **[verified]**:

> "The Pad system [Perlin and Fox 1993] was the first fully zoomable desktop environment, and it
> introduced two important concepts: semantic zooming, which allows objects to be represented
> differently at different scales; and portals, which allow links between data objects and filters on
> their representations."

Note the attribution: **Perlin & Fox's Pad (1993)**, not Pad++. Pad++ [Bederson et al. 1996], Jazz
[Bederson et al. 2000], Piccolo [Bederson et al. 2004a] and ZVTM [Pietriga 2005] are named in the
same sentence as the *toolkits* that followed. Semantic zoom = the representation changes; geometric
zoom = only the scale changes. This is the only definition the survey gives, and it is
representation-centric, not threshold-centric — **the literature does not prescribe discrete tiers**;
tiers are one implementation of "represented differently at different scales".

Terminology warning **[verified]**: Microsoft/WinUI uses "Semantic Zoom" for something else entirely
— "lets the user switch between two different views of the same content to quickly navigate through
a large set of grouped data"
([learn.microsoft.com](https://learn.microsoft.com/en-ca/windows/apps/design/controls/semantic-zoom)).
Don't let that sense leak into the spec.

### Space-scale diagrams

Furnas & Bederson 1995's space-scale diagrams are the framework for reasoning about pan/zoom
together (survey p. 2:8-2:9, Fig. 4) **[verified]**:

> "Figure 4 shows a space-scale diagram, with scale on the y-axis and space on the x/z-axes. The
> user's viewport (Figure 4(a)), shown by the superimposed region, remains a constant size during
> manipulation of scale and space. Clearly, as scale increases (zooming in goes up the y-axis) the
> amount of panning required to traverse the region also increases."

Van Wijk & Nuij [2004] formalised optimal pan-zoom trajectories (survey p. 2:9) — relevant if the
milestone ships a "zoom to note" / "fit" animation.

### Documented failure modes

**Desert fog** (survey p. 2:9) **[verified]**:

> "Another general usability issue associated with zooming is 'desert fog' [Jul and Furnas 1998], a
> term which captures navigation problems caused by an absence of orienting features due to their
> increased separation at high zoom levels. To combat desert fog, Jul and Furnas introduce critical
> zones (a cue-based technique) to provide a visual demarcation of regions that are guaranteed to
> yield further information when zoomed. Alternatively, Bederson [2001] suggests designing the
> interaction to be closely linked to the content so it is impossible to navigate to empty regions."

Two named mitigations, both cheap: (a) **critical zones** — mark regions that will pay off if you
zoom; (b) **Bederson's** — make it impossible to navigate to empty space at all. A curated canvas
with 4 placed notes in an unbounded world is a desert-fog machine: at card tier the user can pan for
thousands of world px and see nothing. (b) is what "fit" and "recent ▴" in the existing status bar
already gesture at (`docs/specs/v0.4-canvas-mvp.md` §14).

**Cognitive load of the temporal separation** (survey p. 2:26, §Conclusions, "Zooming")
**[verified]**:

> "Temporal separation of views can easily create substantial cognitive load for users in assimilating
> the relationship between pre- and post-zoom states; zooming is easy to do badly, as indicated by
> many studies in which it has performed poorly. Animating the transition between zoom levels can
> dramatically reduce the cognitive load (but fine-tuning the duration of the animation is
> important)."

**Animation duration** (survey p. 2:9, §4.3) **[verified]**:

> "Research suggests values between 0.3 and 1.0 second are appropriate [Card et al. 1991; Bederson
> and Boltman 1999; Klein and Bederson 2005], depending on the application domain and distance
> travelled."

That 0.3–1.0 s band is a directly usable number for any programmatic zoom (fit, zoom-to-note,
tier-transition camera moves). tldraw's `animationMediumMs: 320`
(`packages/editor/src/lib/options.ts:294`) sits at the bottom of it **[verified]**.

**Reversibility of zoom actions** (survey p. 2:8, §4.1) **[verified]**:

> "The problem of reversing zooming actions is exacerbated by the fact that undo, that is, the
> standard mechanism for action reversal, is normally reserved for actions that modify the data-state
> and not for those that modify the view. Region-select for zoom-in should be offered with caution
> (although powerful for appropriate uses) because there is no equivalent action for zooming out."

Directly relevant: linsae's spatial undo explicitly excludes camera
(`docs/specs/v0.4-canvas-mvp.md` §13: "NOT covered: delete-note …, camera, …"). The survey says that
is the normal choice *and* names the cost. If the milestone adds a marquee-zoom, it owes a
zoom-back.

**Raskin / ZoomWorld.** Not verified against a primary source in this pass. Raskin's *The Humane
Interface* (2000) proposes ZoomWorld / THE as a single zoomable content plane replacing the file
system; the well-known critique is that it is exactly the desert-fog case at scale. Treat as
background, not evidence.

**Furnas fisheye.** Furnas 1986 "Generalized Fisheye Views" (degree-of-interest = a priori
importance minus distance from focus) is the ancestor of every "show the important things when
zoomed out" rule, including MapLibre's `symbol-sort-key` (§7). Not read in this pass — cited from
the survey's bibliography only **[inferred]**.

**Furnas 1997 "Effective View Navigation"** (CHI '97, 367–374) is the paper that formalises whether a
navigation structure is navigable at all: views must be small, paths short, and every view must carry
"residue" (scent) of what is reachable from it. Read from secondary summary only in this pass
**[inferred]** — but the requirement "all views contain good residue of all nodes" is the literature
statement closest to the semantic-consistency invariant of §10.

---

## Q2 — How shipped products actually do it

### tldraw — primary source, read in full

**tldraw does NOT have a representation-swap LOD. It has attribute simplification plus culling.**
This is the single most useful correction the research produced, because linsae's plan assumes tiers.

Official statement, `apps/docs/content/sdk-features/performance.mdx` **[verified]**:

> "tldraw adjusts rendering fidelity based on zoom level and on-screen size, a technique called level
> of detail (LOD). When a shape is small on screen, rendering every pixel of a high-resolution image
> or every detail of a complex shape is wasted work."

> "**Built-in shape simplifications** — The built-in shapes reduce rendering complexity at low zoom
> levels:
> - **Note shadows** — Box shadows on sticky notes are hidden when zoomed out far enough, replaced by
>   a simple border
> - **Draw shapes** — Freehand strokes switch from their detailed "draw" style to solid paths
> - **Pattern fills** — Hatch and cross-hatch fills switch to solid colors
> - **Text outlines** — Text shadow outlines disable below the `textShadowLod` threshold (default
>   0.35) to reduce compositing cost"

Concrete thresholds, all from source **[verified]**:

| What | Threshold | File:line |
|---|---|---|
| text shadow/outline off | `textShadowLod: 0.35` | `packages/editor/src/lib/options.ts:326`; consumed at `packages/editor/src/lib/components/default-components/DefaultCanvas.tsx` (`const lodDisableTextOutline = efficientZoom < editor.options.textShadowLod`) |
| generic "render simplified solid style" helper | default `0.25` | `packages/tldraw/src/lib/shapes/shared/useEfficientZoomThreshold.ts` — `editor.getEfficientZoomLevel() < threshold`, `threshold = 0.25` |
| note shadows off | `0.25 / scale` | `packages/tldraw/src/lib/shapes/note/NoteShapeUtil.tsx:339` — `const hideShadows = useEfficientZoomThreshold(0.25 / scale)`; the fallback is `borderBottom` (`:366`) and `boxShadow: 'none'` (`:369`) |
| geo shapes force solid fill | `0.25 / shape.props.scale` | `packages/tldraw/src/lib/shapes/geo/GeoShapeUtil.tsx` — `const isForceSolid = this.editor.getEfficientZoomLevel() < 0.25 / shape.props.scale` |
| note clone handles vanish | `zoom * scale < 0.25` (all) / `< 0.5` (some) | `NoteShapeUtil.tsx:227-235` |
| video controls suppressed | on-screen width `< 110 px` | `packages/tldraw/src/lib/shapes/video/VideoShapeUtil.tsx` — `bounds.w * editor.getEfficientZoomLevel() >= 110` |
| pattern-fill raster LOD | `Math.ceil(Math.log2(Math.max(1, zoom)))` | `packages/tldraw/src/lib/shapes/shared/defaultStyleDefs.tsx:166` — power-of-two buckets, one pre-rendered image per bucket, cached at module level (`:115-129`) |
| grid density | 4 overlapping bands, see below | `packages/editor/src/lib/options.ts:300-305` |

**How tldraw "stops rendering detail":** it doesn't stop rendering a shape, it hides off-screen ones
outright. From `performance.mdx` **[verified]**:

> "Shapes outside the viewport don't need to render. The editor maintains a spatial index that tracks
> which shapes are visible, and hides off-screen shapes by setting `display: none` on their DOM
> elements. This means a canvas with 10,000 shapes might only render 50 if the rest are out of view."

**The spatial index is rbush** — same choice as linsae's ADR 0032
(`packages/editor/src/lib/editor/managers/SpatialIndexManager/SpatialIndexManager.ts:19`)
**[verified]**:

> "Uses an R-tree (via RBush) to enable O(log n) spatial queries instead of O(n) iteration."

**At extreme zoom-out tldraw renders nothing special.** There is no dot tier, no title tier, no
placeholder. Confirmed by the official stress-test example
(`apps/examples/src/examples/use-cases/many-shapes/README.md`) **[verified]**:

> "Try zooming out to see level-of-detail transitions: sticky note shadows disappear, draw-style
> strokes simplify to solid paths, and pattern fills flatten to solid colors."

That is the complete list. The ceiling is `maxShapesPerPage: 4000` (`options.ts:291`).

### Excalidraw — primary source

**Geometric zoom only.** `MIN_ZOOM = 0.1`, `MAX_ZOOM = 30`, `ZOOM_STEP = 0.1`
(`packages/common/src/constants.ts:302-304`) **[verified]**. Everything zoom-dependent in the
renderer is *screen-constancy* (`size / zoom.value` for handles, `1 / zoom.value` for line widths,
`SIDE_RESIZING_THRESHOLD / zoom.value` for hit slop), not representation change.

The single LOD-shaped behaviour found is grid-line thinning
(`packages/excalidraw/renderer/staticScene.ts:~91`) **[verified]**:

```js
// don't render regular lines when zoomed out and they're barely visible
if (!isBold && actualGridSize < 10) {
  continue;
}
```

There is a per-element canvas cache (`elementWithCanvasCache` in
`packages/element/src/renderElement.ts`), which is the sprite-cache technique, but it is keyed on the
element, not on a semantic tier **[verified]**.

### Obsidian Canvas — closest product analogue, best evidence outside tldraw

**Obsidian ships exactly the three-tier model linsae is planning**, and the mechanism has a name.
From the `obsidian-canvas-performance-patch` README
([GitHub](https://github.com/Qbject/obsidian-canvas-performance-patch/blob/main/README.md))
**[verified, third-party reverse-engineering of closed source]**:

> "Most of the canvas node types are replaced with a lightweight preview when zoomed out. But media
> embeds are an exception - they're made to be visible at any zoom level."

The mechanism is a per-node `updateBreakpoint()` method that **dismounts content** when zoomed out.
The README documents the failure mode this creates:

> "media embeds are removed and inserted right back every frame when user navigates a canvas while
> zoomed out" … "The simplest way to solve this is to remove calling the parent `updateBreakpoint`
> within `FileNode`."

**This is a cautionary tale linsae should read as a design constraint:** a per-node
mount/unmount-on-tier-change, with any subclass that re-mounts, produces per-frame DOM churn — the
exact thing ADR 0033's motion-LOD exists to avoid.

Second finding from the same README **[verified]**: Obsidian applies `backface-visibility: hidden` to
`.canvas-node-content`, and

> "This property causes canvas layout calculation to take significantly much more time."

That is a second instance of the general lesson from the linsae spike: **a compositing/containment
CSS hint applied per node on a transformed surface can be a net loss.** (It is a *different*
mechanism from `content-visibility` and from `will-change` — see §4.)

Behaviour and settings, from the Obsidian forum **[verified, community, not official]**:
- Zoomed out past a threshold, notes "only show their headings and no longer the content of the
  note"; zoomed out further, the titles disappear too
  ([forum thread 57181](https://forum.obsidian.md/t/stop-content-of-note-from-being-hidden-when-canvas-is-zoomed-out/57181),
  [thread 78352](https://forum.obsidian.md/t/how-do-i-stop-canvas-card-titles-from-disappearing-when-zoomed-far-out/78352)).
- There is a user-facing setting **"Zoom threshold for hiding card content"**, and users report that
  even at its maximum they cannot keep titles visible at far zoom (thread 78352). Obsidian exposes a
  CSS var `--zoom-multiplier` that theme authors use to fight this.
- No concrete zoom numbers are published. **Not verified.**

Design read **[inferred]**: shipping the threshold as a user setting is Obsidian conceding that no
single value works. It is also evidence that "titles vanish entirely at far zoom" is a real
complaint, not a hypothetical — which argues for linsae's "labels on hover/proximity at dot zoom"
(§7) rather than "no labels at all".

### The rest — no primary source available

| Product | Representation change at zoom? | Evidence quality |
|---|---|---|
| **Figma** | No semantic tiers for design content (WYSIWYG fidelity is the product). Tile-based WebGL/WebGPU renderer; blur-then-sharpen at new zoom levels is a *raster* artifact, not a semantic tier. | Blog posts only ([Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/), [Figma Rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)). **No evidence of semantic zoom found. Inferred.** |
| **Miro** | Progressive disclosure exists but is *interaction*-gated, not zoom-gated: Card title is always visible, description "is only visible if you scroll in close enough to reveal it, or click on the card". | Community forum only. **Weak.** |
| **Heptabase** | Yes, one concrete behaviour: when you zoom out, **the Section's name stays visible while everything else shrinks to tiny** — i.e. a scale-invariant group label. | Secondary/marketing summaries only. **Weak but directionally useful — this is exactly the "labels at dot zoom" pattern.** |
| **Muse** | Nested boards + "fast switching between fully zoomed in and fit-to-window", breadcrumb navigation. The design bet is *nesting instead of deep zoom*. | App Store / marketing copy; the primary memo at `museapp.com/memos/2020-12-infinite-canvas/` **404s as of 2026-08-02**. **Weak.** |
| **Kosmik / Scrintal / Milanote** | No evidence of semantic zoom found. Milanote documents plain geometric zoom ([help.milanote.com](https://help.milanote.com/en/articles/1721940-zoom-in-out)). | **None / negative.** |
| **Prezi** | Zoom *is* the navigation primitive (frames/topics), with automatic zoom animation between them. Discrete authored waypoints, not continuous representation LOD. | Vendor docs ([support.prezi.com](https://support.prezi.com/hc/en-us/articles/360003498793-How-to-use-zoom-in-Prezi-Present)). **Medium.** |

**Bottom line for Q2 [inferred]:** of eleven products surveyed, exactly **two** ship a
representation-swapping semantic zoom — Obsidian Canvas (content → title → nothing) and, partially,
Heptabase (scale-invariant section labels). The best-engineered canvas in the set (tldraw) chose
*not* to, and instead spent its budget on culling + attribute simplification + freezing the LOD input
during motion. That is a real signal about cost/benefit, and the milestone should be able to say why
linsae is doing the harder thing.

---

## Q3 — Hysteresis at tier boundaries

### The games answer: separate enter/exit thresholds

Canonical statement, [DigitalRune LOD docs](https://digitalrune.github.io/DigitalRune-Documentation/html/b320aebd-46a0-45d8-8edb-0c717152a56b.htm)
**[verified]**:

> "The LOD hysteresis adds a hysteresis to LOD switches." … "The LOD distance for LOD2 is 100. With
> an LOD hysteresis of 10, the object transitions from LOD1 to LOD2 at distance 105, and from LOD2 to
> LOD1 at distance 95."

So the band is symmetric around the nominal threshold, ±5% in their example. Unreal exposes the same
knob as `FSkeletalMeshLODInfo::LODHysteresis`; Unity/Godot have equivalents (Godot's is
[godotengine/godot#6375](https://github.com/godotengine/godot/issues/6375)); three.js notably still
lacks it ([mrdoob/three.js#14565](https://github.com/mrdoob/three.js/issues/14565)) — so if you want
it in a JS renderer you hand-roll it. **No source gives a recommended ratio.** DigitalRune declines
to: "No specific recommended values are provided."

Same page, on the alternative **[verified]**:

> "LOD blending can be used to create smooth transitions between LODs" using "screen-door transparency
> (stipple patterns)." … "LOD blending can be expensive: The workload increases during transitions.
> Two models need to be rendered instead of one." … recommends "keeping transition phases short
> through the hysteresis property."

### The canvas answer: freeze the LOD input while the camera moves

This is what tldraw actually does, and it is a strictly better fit for a wheel-driven camera than
hysteresis, because a wheel gesture produces dozens of zoom values in ~200 ms.

`packages/editor/src/lib/editor/Editor.ts:3199-3243` **[verified]**:

```ts
private _debouncedZoomLevel = atom('debounced zoom level', 1)

/**
 * Get the debounced zoom level. When the camera is moving, this returns the zoom level
 * from when the camera started moving rather than the current zoom level. This can be
 * used to avoid expensive re-renders during camera movements.
 */
@computed getDebouncedZoomLevel() {
  if (this.options.debouncedZoom) {
    if (this.getCameraState() === 'idle') {
      return this.getZoomLevel()
    } else {
      return this._debouncedZoomLevel.get()
    }
  }
  return this.getZoomLevel()
}

@computed private _getAboveDebouncedZoomThreshold() {
  return this.getCurrentPageShapeIds().size > this.options.debouncedZoomThreshold
}

@computed getEfficientZoomLevel() {
  return this._getAboveDebouncedZoomThreshold()
    ? this.getDebouncedZoomLevel()
    : this.getZoomLevel()
}
```

The snapshot is taken exactly once, at the idle→moving edge (`Editor.ts:4776-4780`) **[verified]**:

```ts
private _tickCameraState() {
  this._cameraStateTimeoutRemaining = this.options.cameraMovingTimeoutMs
  if (this.getInstanceState().cameraState !== 'idle') return
  this._setCameraState('moving')
  this._debouncedZoomLevel.set(unsafe__withoutCapture(() => this.getCamera().z))
  this.on('tick', this._decayCameraStateTimeout)
}
```

Constants **[verified]**: `cameraMovingTimeoutMs: 64`, `debouncedZoom: true`,
`debouncedZoomThreshold: 500` (`options.ts:315,341-342`). And the same block explains *why* it exists,
in the culling comment (`Editor.ts:4763-4768`):

> "Changing the rendering shapes may cause shapes to unmount / remount in the DOM, which is expensive;
> and computing visibility is also expensive in large projects. For this reason, we use a second
> bounding box just for rendering, and we only update after the camera stops moving."

The docs make the guidance explicit: "These transitions use `Editor#getEfficientZoomLevel` so they
stay stable during camera movement rather than updating every frame." **[verified]**

**Consequence for the flicker case in the brief:** with freeze-during-gesture there is *no* tier
change during a wheel gesture at all. The user hovering at exactly 0.5 sees one tier switch, 120 ms
after they stop. Flicker is structurally impossible, not statistically reduced.

### The third answer: cross-fade over a band, no threshold at all

tldraw's grid, `packages/editor/src/lib/components/default-components/DefaultGrid.tsx` **[verified]**:

```tsx
const opacity = z < mid ? modulate(z, [min, mid], [0, 1]) : 1
```

with (`options.ts:300-305`):

```ts
gridSteps: [
  { min: -1,   mid: 0.15,  step: 64 },
  { min: 0.05, mid: 0.375, step: 16 },
  { min: 0.15, mid: 1,     step: 4  },
  { min: 0.7,  mid: 2.5,   step: 1  },
],
```

Every band is drawn every frame; only opacity changes, and the bands **overlap heavily**. The
`mid/min` ratios are 7.5×, 6.67× and 3.57× — i.e. the fade spans a factor of ~3.5–7.5 in zoom, not a
few percent **[verified, ratios are my arithmetic]**. Nothing ever pops.

MapLibre uses the same shape for label collision: `fadeDuration: 300` ms default
(`src/ui/map.ts:539`), applied only once the map is idle-triggered (`src/ui/map.ts:4220`:
`const fadeDuration = this._idleTriggered ? this._fadeDuration : 0;`) **[verified]**. Opacity is
integrated per frame toward placed/not-placed (`src/symbol/placement.ts:31`).

### Recommendation

**[inferred]** Three mechanisms, in cost order, and they compose:

1. **Freeze the tier input during gesture** (tldraw). linsae already has `isMoving` with a 120 ms
   settle (`useCanvasCamera.ts:29,93-97`). This is a ~10-line change: keep a `zoomForTier` ref,
   snapshot `camera.zoom` on the `false→true` edge of `isMoving`, and feed `tierForZoom` from the
   snapshot while moving. Cost: none. Removes flicker entirely.
2. **Cross-fade the two representations over a band** rather than switching at a point. Costs
   double-render inside the band (DigitalRune's warning), so keep the band narrow *or* keep both
   representations cheap.
3. **Hysteresis** only if 1 and 2 leave a problem — e.g. a keyboard zoom-step that lands exactly on
   0.5 repeatedly. Shape: `enterTitle = 0.5`, `exitTitle = 0.5 × r`. **No source prescribes r.**
   If you need a starting number, `r ≈ 1.2` (down at 0.5, back up at 0.6) is the same order as
   DigitalRune's ±5% scaled to a multiplicative axis — but that is **my synthesis, not a citation**.

---

## Q4 — Rendering the title tier (0.15 ≤ zoom < 0.5)

### The geometry first

At `zoom = 0.5` a 360 world-px card is 180 screen px; at `zoom = 0.15`, 54 px. Body text at 14 px
world is 7 px then 2.1 px. **The title tier is correct as a concept** — body text is illegible across
the whole band. `CARD_WIDTH = 360` from `src/renderer/src/canvas/CanvasStage.tsx:217` **[verified]**.

For the title to stay readable it must be **screen-constant**, i.e. drawn at `fontPx / zoom` in world
units. linsae already has this idiom in production — `drawTypePill`
(`CanvasStage.tsx:276-307`) **[verified]**:

```ts
const fontPx = 11 / z // screen-constant 11px label
const padX = 5 / z
const h = 16 / z
const r = 4 / z // corner radius
ctx.font = `${fontPx}px ${fontFamily}`
```

with the caller gating on `camera.zoom >= TYPE_PILL_MIN_ZOOM`, colours pre-resolved so
`getComputedStyle` is never called per-edge, and `save()`/`restore()` for hermeticity. **A canvas-2D
title tier is a near-copy of this function.** That is a strong argument for canvas-2D over DOM: the
code already exists and the perf characteristics are already understood.

### DOM text vs `ctx.fillText` — the real deciding factor is rasterization, not text cost

**Chromium re-rasters composited content when the transform scale changes.** From
[Re-rastering composited layers on scale change](https://developer.chrome.com/blog/re-rastering-composite)
(Chrome for Developers) **[verified]**:

> "Starting in Chrome 53, all content is re-rastered when its transform scale changes, if it does not
> have the `will-change: transform` CSS property."

> "`will-change: transform` means 'please animate it fast'" and "can be thought of as forcing the
> content to be rastered into a fixed bitmap, which subsequently never changes under transform
> updates."

> "developers can choose between quality and speed, on a per-element and per-animation frame basis by
> adding and removing `will-change: transform`."

> "you may want to add `will-change: transform` when animations begin and remove it when they end."
> … "if you have a layer with `will-change: transform` on it and simply wish to trigger a re-raster
> but then continue animating, you must remove `will-change: transform`, then re-add it in a
> `requestAnimationFrame()` callback."

Chromium's own `how_cc_works.md` confirms the machinery **[verified]**:

> "Each scale is represented by a `PictureLayerTiling`, which is a sparse 2d regular tiling of the
> content at a particular scale." … "There are a number of heuristics to determine when and how to
> change rasterization scales. These aren't perfect, but change them at your own peril."

**linsae's current state [verified]:** the world container carries
`translate(...) scale(${camera.zoom})` (`CanvasStage.tsx:1734-1736`), and `grep -rn "willChange|will-change" src/renderer/src/`
returns **nothing**. So every mounted card subtree is re-rastered on every zoom frame today. The
spike's zoom-trough dips (`docs/research/2026-06-12-canvas-spike-results.md` §Verdict: "concentrated
where cards enter … and at the zoom trough") are consistent with this, though the spike did not
isolate it **[inferred]**.

### Does the `content-visibility` caveat transfer to `will-change` and `contain`?

**No — and this matters.** The three are different mechanisms with different failure modes
**[inferred from verified mechanism descriptions]**:

| Property | What it does under animated scale | Verdict for linsae |
|---|---|---|
| `content-visibility: auto` | Re-evaluates *relevance* and does style/layout work per boundary per frame. Measured: 11–12 fps, 42–44 frames >100 ms; `cull+cv` strictly worse than `cull` with `cvSkipped = 0` (`docs/research/2026-06-12-canvas-spike-results.md` §Numbers) | **Banned (ADR 0032). Keep banned.** |
| `will-change: transform` | *Suppresses* re-raster by pinning the raster scale; costs GPU memory and visual sharpness | **Not the same failure. Candidate lever, gated on `isMoving`.** |
| `contain: layout/paint` | Scopes layout/paint invalidation. Not measured by the spike at all | **Unknown. Do not assume either way.** |
| `backface-visibility: hidden` | Obsidian's canvas does this; a third party measured it makes "canvas layout calculation take significantly much more time" | **Avoid; and it is evidence the general class of hints is not free.** |

### The memory cost of layer promotion

MDN's warning, quoted in full because it is the counterweight
([MDN `will-change`](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)) **[verified]**:

> "**Warning:** Use the `will-change` property as a last resort to try to deal with existing
> performance problems. Don't use it to anticipate performance problems."

> "**Don't apply `will-change` to too many elements**: The browser already tries as hard as it can to
> optimize everything. Some of the stronger optimizations that are likely to be tied to `will-change`
> end up using a lot of a machine's resources. Overusing the property can cause the page to slow down
> instead of improving it's performance."

> "**Use sparingly**: … adding `will-change` directly to a stylesheet implies that the targeted
> elements are always a few moments away from changing and the browser will keep the optimizations for
> a much longer time than it would have otherwise. So it is a good practice to switch `will-change`
> on and off using script code before and after the change occurs."

> "Excessive use of `will-change` will result in excessive memory use and will cause more complex
> rendering to occur as the browser attempts to prepare for the possible change."

Order-of-magnitude arithmetic for linsae **[my arithmetic, not measured]**: a composited layer costs
`w × h × dpr² × 4` bytes. One card at `360 × 140` world px, dpr 1 → ~197 KB. The spike's ~109 mounted
cards → **~21 MB**; at dpr 2 → **~86 MB**. That is affordable for a gesture-scoped promotion, and
clearly not affordable as a permanent stylesheet rule. `KEEP_ALIVE_SIZE = 32`
(`CanvasStage.tsx:205`) adds 32 more hidden cards to the count.

### `fillText` cost

The only concrete numbers found are old and Firefox-skewed
([Mirko Sertic, 2015](https://www.mirkosertic.de/blog/2015/03/tuning-html5-canvas-filltext/))
**[verified but 2015 — treat as directional only]**:

- Before: Firefox 36 / Linux "10 ms / frame", "41% is used by `fillText()`"; Chrome 39 / Linux
  "5 ms / frame", "only 1 % is used by `fillText()`".
- After caching each string into an offscreen canvas once and blitting with `drawImage`:
  Firefox "1 ms / frame", "<1%"; Chrome 41 / Windows "<1 ms / frame".
- Technique: "create an Offscreen Canvas element, draw the text only once, and use the Canvas as a
  bitmap resource to render it using the `drawImage()` method."

Note Chrome was already cheap in that test — the 41%→<1% swing is Firefox's. Electron 42 is Chromium.
**So the sprite cache is a known-good escalation, not a required first move [inferred].**

Corroborating scale data point (Leaflet.Canvas-Markers README, third-party) **[verified as a claim,
not independently reproduced]**: 100 000 DOM markers used "up to 2.8 GB of memory and took 160-200
seconds to load", versus "about 300 MB and loaded in less than 1 second" on canvas.

### Recommendation for the title tier

**[inferred]**

- **Draw titles on the existing `CanvasUnderlay`, not in DOM.** Reuse the `drawTypePill` idiom
  (screen-constant `px / zoom`, pre-resolved tokens, `save`/`restore`). This sidesteps the re-raster
  question entirely for the title tier, keeps `will-change` out of it, and reuses a tested pattern.
  It also means the title tier costs zero DOM mounts, which is the whole point of ADR 0033's
  amortization.
- **Measure before optimising.** Add a `title` phase to `scripts/canvas-perf-harness.mjs` mirroring
  the existing `dot` phase: `forceTier: 'title'`, N synthetic titles, unclamped zoom, p95 ≤ 18 ms.
  Escalate to an offscreen-canvas/`ImageBitmap` label atlas only if it fails. `measureText` results
  must be cached per (string, font) regardless.
- **Separately**, consider `will-change: transform` on the *world container* while `isMoving`, as a
  card-tier lever. This is orthogonal to the title tier and should be its own experiment with its own
  gate — the harness's `churn`/`steady` phases pan at zoom 1 and would not exercise it
  (`docs/harness/canvas-perf.md` §Three phases), so a new zoom-sweep phase is needed to measure it at
  all.

---

## Q5 — Rendering the dot tier at scale

### What the spike actually measured

`scripts/spike-canvas/page/dots.js` in full, the load-bearing lines **[verified]**:

```js
const N = 10000
const pos = new Float32Array(N * 2)
for (let i = 0; i < N; i++) {
  pos[i * 2]     = rand() * 10000
  pos[i * 2 + 1] = rand() * 6600
}

const draw = () => {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#3b6ea5'
  const { x, y, z } = S.cam
  for (let i = 0; i < N; i++) {
    const sx = (pos[i * 2]     - x) * z + w / 2
    const sy = (pos[i * 2 + 1] - y) * z + h / 2
    if (sx < -2 || sy < -2 || sx > w + 2 || sy > h + 2) continue
    ctx.fillRect(sx - 1, sy - 1, 2, 2)
  }
}

const st = await S.runChoreo(
  { durationMs: 10000, panX: [4000, 6000], panY: [3000, 3600], baseZ: 0.1, zoomAmp: 0.5 },
  draw,
)
```

So the conditions are: **repainted every frame** (yes, not static), 10k points, **2 × 2 px
axis-aligned `fillRect`**, **per-dot screen-space cull before the draw call**, one `fillStyle` set for
the whole loop, no per-dot allocation, flat `Float32Array`, pan+zoom choreography around `z = 0.1`
over a 10 000 × 6 600 field. Result: 60 fps, p95 = vsync, zero frames >17 ms across all runs
(`docs/research/2026-06-12-canvas-spike-results.md` §Numbers, §Verdict) **[verified]**.

**That is a clean PASS for that primitive under those conditions and nothing more.** In particular it
says nothing about arcs, nothing about text, nothing about per-dot colour changes (which would force
a `fillStyle` write per dot), and nothing about hit-testing.

The production port is faithful (`CanvasStage.tsx:661-689`) and adds the world-space version of the
same cull **[verified]**.

### The batched-`Path2D` question — the repo's own answer is not the whole story

`CanvasStage.tsx:647-651` **[verified]**:

> "Why fillRect, not a batched `beginPath()`/arc/`fill()`: the arc path built all 10k subpaths every
> frame regardless of visibility (no cull) and filled them as one path over the whole field's bbox —
> measured 5.4fps / p95 533ms at the dot tier (#124, gate p95 ≤ 18ms). Axis-aligned `fillRect`s skip
> the transcendental arc cost and the giant single-path fill."

**That measurement changed three variables at once** — `arc` vs `rect`, cull vs no cull, and rebuild-
per-frame vs reuse. tldraw's production minimap is the controlled counter-example
(`packages/tldraw/src/lib/ui/components/Minimap/MinimapManager.ts:198-219, 246-256`) **[verified]**:

```ts
// Shape geometry in page space, split into unselected/selected fills. Built
// from the per-shape rect cache and selection only, so it survives pan/zoom of
// the main canvas — those move the `ctx` transform, not the paths themselves.
@computed
private getShapePaths() {
  const shapes = new Path2D()
  const selected = new Path2D()
  for (let i = 0, len = ids.length; i < len; i++) {
    const bounds = this.shapeRectCache.get(shapeId)
    if (!bounds) continue
    const target = selectedIds.has(shapeId) ? selected : shapes
    target.rect(bounds.x, bounds.y, bounds.w, bounds.h)
  }
  return { shapes, selected }
}
```

…then, per frame, `ctx.scale(dpr*zoom, dpr*zoom); ctx.translate(...)` followed by exactly **two**
`ctx.fill(path)` calls. The paths are built in **page space** and cached by the reactive `@computed`,
so a pan or zoom does not rebuild them — only the context transform moves.

**[inferred]** The honest conclusion for Q5:
- `fillRect`-per-visible-dot **is verified** to hit the gate at 10k on this hardware.
- "batched `Path2D` is slower" **is not** established. What is established is that *rebuilding 10k
  arc subpaths every frame with no cull* is slower. A cached `Path2D` of `rect()`s, rebuilt only on
  layout change, is a legitimate alternative that tldraw ships — and it moves the per-frame cost from
  O(visible dots) JS-loop to one native fill, at the cost of losing the per-dot cull (which for a
  whole-vault overview, where nearly everything is on screen, is worth little).
- `arc()` specifically is worth avoiding: it is transcendental per dot and the spike/production both
  chose against it.
- The two options should be A/B'd in the existing `dot` harness phase if the dot tier becomes the
  primary surface. This is cheap: one extra scenario.

### When WebGL becomes necessary

**[inferred, no new external measurement]** The spike's verdict stands — "canvas 2D suffices for the
far tier at v0.x; WebGL escalation not needed at this scale". At 438 real notes, the dot tier is
~2% of the measured load. The escalation trigger is not dot count; it is **per-dot state changes**
(colour per note type, per-dot alpha for decluttering) which serialise the batch, and **text**, which
canvas-2D handles badly at scale. If the dot tier grows per-note colour + labels, re-measure before
assuming the 10k headroom survives.

`OffscreenCanvas` in a worker is the intermediate escalation. The one figure found is "~20% speedup"
for "hundreds or thousands of `fillText()` calls at every frame" — third-party, unverified,
worth knowing but not worth planning around.

**Sprite atlas / `ImageBitmap` + `drawImage`** is the right escalation *for labels*, not for dots — a
2 px square is cheaper to fill than to blit.

---

## Q6 — Hit-testing at dot tier

### The standard shape: inflate the query, then rank by distance

tldraw does exactly "inflated radius + snap-to-nearest", in two stages **[verified]**.

Stage 1 — inflate the point into a box and query the R-tree
(`SpatialIndexManager.ts:320-323`):

```ts
getShapeIdsAtPoint(point: { x: number; y: number }, margin = 0): Set<TLShapeId> {
  this.spatialIndexComputed.get()
  return this.rbush.search(new Box(point.x - margin, point.y - margin, margin * 2, margin * 2))
}
```

Stage 2 — the margin is **screen-constant**, i.e. divided by zoom (`Editor.ts:5847-5851`):

```ts
@computed getHitTestMargin(): number {
  const { hitTestMargin, coarseHitTestMargin } = this.options
  const margin = this.getInstanceState().isCoarsePointer ? coarseHitTestMargin : hitTestMargin
  return margin / this.getZoomLevel()
}
```

with `hitTestMargin: 3`, `coarseHitTestMargin: 4`, and for handles `handleRadius: 12`,
`coarseHandleRadius: 20`, `coarsePointerWidth: 12` (`options.ts:316-323`). MapLibre's analogous
`clickTolerance: 3` (`src/ui/map.ts:541`) is the same number **[verified]**.

Stage 3 — among in-margin candidates, tldraw keeps `inMarginClosestToEdgeHit` /
`inMarginClosestToEdgeDistance` and returns the nearest (`Editor.ts:5907-5908`, and the
`geometry.distanceToPoint(...)` comparisons at `Editor.ts:~5963-6010`) **[verified]**. That is
snap-to-nearest, implemented by hand over the candidate set — **not** by a kNN index.

### rbush and kNN — current API, verified

`rbush@4.0.1` is installed (`node_modules/rbush/package.json`). Its API is `insert`, `load`, `remove`,
`clear`, `search({minX,minY,maxX,maxY})`, `collides(...)`, `all()`, `toJSON()`/`fromJSON()`.
**There is no `knn` and no `update`** — the README says so explicitly **[verified]**:

> "### K-Nearest Neighbors
> For "*k* nearest neighbors around a point" type of queries for RBush, check out
> [rbush-knn](https://github.com/mourner/rbush-knn)."

(`linsae`'s `spatial-index.ts:8-9` already records the no-`update` finding.)

`rbush-knn` **[verified via `npm view` + README, 2026-08-02]**: version **4.0.0**, last published
**2024-07-05**, one dependency (`tinyqueue@^2.0.3`), ESM, same author as rbush. API:

```
knn(tree, x, y, [k, filterFn, maxDistance])
```

> "- `k`: number of neighbors to search for (`Infinity` by default)
> - `filterFn`: optional filter function; `k` nearest items where `filterFn(item) === true` will be returned.
> - `maxDistance` (optional): maximum distance between neighbors and the query coordinates (`Infinity` by default)"

`maxDistance` is exactly the "snap radius" knob. Maintenance read **[inferred]**: two years without a
release from a maintainer who is still active on rbush is *quiescent*, not abandoned — but it is a
new runtime dependency, which trips CLAUDE.md's hard gate ("No new dep") for anything inline, and
knip will police it.

**Recommendation [inferred]:** for a snap-to-nearest over the candidates returned by an inflated
`search()`, a hand-rolled linear scan is O(candidates) with candidates bounded by the inflated box —
typically <10. `rbush-knn` buys nothing there. Reach for `rbush-knn` only if the product wants
"nearest note anywhere on the canvas" with no radius bound (e.g. a keyboard "jump to nearest
neighbour" command). **Do not add the dep for click hit-testing.**

### WCAG 2.2 target size — the criterion that actually applies

**SC 2.5.8 Target Size (Minimum), Level AA** ([W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/#target-size-minimum))
**[verified]**:

> "The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except when:"

with five exceptions. The one that governs a dot field, quoted verbatim from the
[Understanding document](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
**[verified]**:

> "**Spacing:** Undersized targets (those less than 24 by 24 CSS pixels) are positioned so that if a
> 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect
> another target or the circle for another undersized target"

and the escape hatch that a dot field will need:

> The "Essential" exception applies when "position of pins is analogous to the position of places
> shown on the map" or in "interactive data visualization where targets are necessarily dense".

**SC 2.5.5 Target Size (Enhanced), Level AAA** is 44 × 44 CSS px **[verified]**.

**What this means concretely [inferred]:** a 3–4 px visual dot with a 24 px effective click target is
**compliant** provided no two dots come within 24 screen px of each other. At `zoom = 0.1`, 24 screen
px = 240 world px — with `DOT_SCREEN_RADIUS = 3` (`CanvasStage.tsx:263`) and a real vault, dots
*will* come closer than that. At that point you are relying on the **Essential** exception, which
WCAG explicitly grants to dense data visualisations. That is a defensible position, but it should be
a written decision (an ADR line), not an accident. The practical mitigations that keep you honest:
snap-to-nearest with a bounded radius (so no click is ever "dead"), and hover feedback that names the
target before the click commits (§7).

**A concrete inflation rule [inferred]:** query with
`margin = max(DOT_SCREEN_RADIUS, 12) / zoom` world units — 12 = half of WCAG's 24 — then rank
candidates by squared distance and take the nearest. `coarseHitTestMargin`-style widening for coarse
pointers is free once the rule is expressed in screen px.

---

## Q7 — Label decluttering at dot zoom

### The theory: the problem is NP-hard, and greedy is fine

Christensen, Marks & Shieber, "An Empirical Study of Algorithms for Point-Feature Label Placement",
*ACM Transactions on Graphics* 14(3), 1995, 203–232
([PDF](https://www.eecs.harvard.edu/~shieber/Biblio/Papers/tog-final.pdf),
[DOI](https://dl.acm.org/doi/10.1145/212332.212334)). Abstract, verbatim **[verified]**:

> "Point-feature label placement (PFLP) is the problem of placing text labels adjacent to point
> features on a map or diagram so as to maximize legibility. … Complexity analysis reveals that the
> basic PFLP problem and most interesting variants of it are NP-hard. These negative results help
> inform a survey of previously reported algorithms for PFLP; not surprisingly, all such algorithms
> either have exponential time complexity or are incomplete. To solve the PFLP problem in practice,
> then, we must rely on good heuristic methods."

Conclusions, verbatim **[verified]**:

> "The experiments also argue for the use of simulated annealing over the alternatives when solution
> quality is critical. **For time-critical applications, the annealing schedule can often be shortened
> or eliminated altogether while still providing reasonable solutions.**" (emphasis mine)

And the quality ranking from Figure 10 (objective-function values on a 750-point map; **lower is
better**) **[verified]**: Simulated Annealing **75** · Zoraster's **219** · Discrete Gradient Descent
**222** · Hirsch's **222** · Greedy Depth-First **341** · Random **564**.

**Read: greedy is ~4.5× worse than annealing but ~1.7× better than random, at a fraction of the
cost.** For an interactive overview where labels appear on hover/proximity — i.e. where only a handful
are shown at once — greedy is unambiguously the right call.

### The practice: MapLibre is greedy-in-priority-order over a uniform grid

MapLibre's collision system, from source **[verified]**:

- The index is a **uniform grid**, not an R-tree: `GridIndex` with
  `xCellCount = Math.ceil(width / cellSize)` (`src/symbol/grid_index.ts:62-99`), supporting
  `insert(key, x1,y1,x2,y2)`, `insertCircle(key, x, y, radius)`, `hitTest(...)`,
  `hitTestCircle(...)`. Circles are inserted via their bounding box with an explicit comment:
  "It's more than necessary (by a factor of 4/PI), but fast to insert" (`grid_index.ts:120`).
- Placement is **first-come-first-served in priority order**: `symbol-sort-key` produces
  `sortKeyRanges`, and symbols are placed in that order (`src/symbol/placement.ts:303-314`). Also
  supported: `symbol-z-order: 'viewport-y'` (`placement.ts:435, 823-827`).
- Per-symbol overlap policy is `OverlapMode` — `'always'` is "allowed to overlap anything"
  (`grid_index.ts:34-38`), which is how "this label must never be hidden" is expressed.
- Placement is padded beyond the viewport so churn happens off-screen
  (`src/symbol/collision_index.ts:23-30`) **[verified]**:

  > "When a symbol crosses the edge that causes it to be included in collision detection, it will
  > cause changes in the symbols around it. This constant specifies how many pixels to pad the edge of
  > the viewport for collision detection so that the bulk of the changes occur offscreen. Making this
  > constant greater increases label stability, but it's expensive."
  >
  > `export const viewportPadding = 100;`

- Transitions are **opacity fades**, integrated per frame toward the placed/unplaced target
  (`placement.ts:31`), default `fadeDuration: 300` ms (`src/ui/map.ts:539`), and suppressed until the
  map is idle-triggered (`src/ui/map.ts:4220`) **[verified]**.

### The cheap correct version for linsae

**[inferred]** In order of increasing cost, stop at the first that suffices:

1. **Hover / proximity only** (what the vision already says). Show the label for the nearest dot to
   the cursor (reuse the §6 snap-to-nearest result) plus, optionally, the k nearest. Zero collision
   problem: 1–3 labels never collide meaningfully, and you can just offset the second one.
2. **Selection + recency privilege.** Always label selected notes and the most-recent N; these are
   `overlapMode: 'always'`-equivalent. `recentOnCanvas` already exists
   (`docs/specs/v0.4-canvas-mvp.md` §14).
3. **Greedy budget pass**, only if a "label everything you can" mode is wanted: sort by priority
   (recency/frecency — ADR 0041 already has the ranking), walk in order, test each label's screen
   AABB against a uniform grid keyed on screen cells, place-or-skip, cap at N labels. This is ~40
   lines and is literally MapLibre's algorithm minus the parts that exist for tiles and globes.
4. Cross-fade placements with a ~300 ms opacity ramp so a pan doesn't strobe the label set, and only
   recompute placement on **settle** (`isMoving === false`) — MapLibre's `_idleTriggered` gate,
   which linsae already has as `isMoving`.

Do **not** implement annealing.

---

## Q8 — Minimap

### The literature says a separate minimap may actively hurt when semantic zoom exists

Cockburn survey §7.2.2, verbatim **[verified]**:

> "To better understand the contribution of each of these components to interaction, Hornbaek et al.
> [2002] evaluated user performance in map navigation tasks when using a zooming interface that either
> had or did not have an additional overview+detail region. They also controlled whether the zooming
> functions did or did not support semantic zooming; when semantic zooming was on, the labels in the
> map were tailored to provide appropriate detail for that zoom level (similar to Google Maps), but
> when semantic zooming was off the labels were only legible when the map was zoomed-in. Surprisingly,
> and contradicting Pietriga et al.'s [2007] analysis of low-level interaction, **their results showed
> that overview+detail regions increased task completion times when semantic zooming was enabled, and
> they suggest that this cost is due to the overview being made redundant by the semantic detail.**
> When semantic zooming was disabled there was no difference between performance with overview+detail
> and zooming interfaces. **The participants preferred the interface with the overview despite their
> slower performance**, stating that it helped them orient themselves within the information space."
> (emphasis mine)

And §7.2.3 **[verified]**:

> "The study by Hornbaek et al. [2002] also produced results on the impact of overview+detail
> interfaces on spatial recollection, finding that **recall was better after using the nonoverview
> interface**."

The survey's own concluding recommendation on overview+detail **[verified]**:

> "Notable disadvantages of overview+detail are the additional use of screen real estate (which may be
> more effectively used for details) and the mental effort and time required to integrate the distinct
> views. **The real estate issue can often be addressed by offering users control over whether to
> display the overview.** For consistency with state-of-the-art interfaces, users should be able to
> browse the overview without influencing the detail view, but changes in the detail view should be
> immediately reflected in the overview."

**This is direct support for `docs/canvas-vision.md:28-29`** ("The far-zoom dot tier eventually takes
the 'where is everything' job (it is the minimap; a separate minimap widget is permanently ruled
out)"). The one caveat the vision does not acknowledge: **users preferred having the overview even
though it made them slower.** A "permanently ruled out" that contradicts a measured preference is a
position worth restating with that fact in it.

### Same renderer at a different camera, or a separate one? — tldraw chose separate

tldraw's minimap is **a wholly separate, radically simplified renderer**, not the main renderer at a
different camera **[verified]**:

- Its own `<canvas>` + `MinimapManager` (`DefaultMinimap.tsx:38`), own 2D context
  (`MinimapManager.ts:32`).
- Every shape is reduced to **its page-space bounding rect**, batched into two `Path2D`s
  (unselected / selected) and drawn with two `ctx.fill()` calls (`MinimapManager.ts:198-256`).
- Its camera is derived, not shared: `getCanvasPageBounds()` = the union of all shape bounds and the
  current viewport, aspect-corrected (`MinimapManager.ts:74-79, 116-134`).
- The viewport indicator is drawn as a filled rect, with a micro-optimisation worth stealing
  (`MinimapManager.ts:258-269`): "roundRect is pricier than rect, so when the corner radius would be
  sub-pixel on screen (and thus invisible) fall back to a plain rect."
- Off-screen collaborator cursors are drawn as `arc` dots at `3 / zoom` — the same screen-constant
  3 px dot linsae uses — "including off-screen collaborators, which is the point of a minimap."

### Interaction conventions (tldraw, verified from `DefaultMinimap.tsx`)

- **Click outside the viewport rect → jump**, animated: `editor.centerOnPoint(point, { animation: { duration: editor.options.animationMediumMs } })` (`:68`, `:108`) — 320 ms, inside the survey's
  0.3–1.0 s band.
- **Drag starting inside the viewport rect → drag the viewport** preserving the grab offset
  (`minimap.isInViewport` at `:111`, `editor.centerOnPoint(Vec.Sub(point, delta))` at `:155`);
  **drag starting outside → continuous recenter** (`:159`).
- A squared-distance click/drag threshold ignores "sub-pixel pointer jitter that accompanies a click,
  so it doesn't cut off the easing animation started on pointer down" (`:18-19`, `:147-148`).
- **On-demand, and collapsed by default**: `useLocalStorageState('minimap', true)` in
  `DefaultNavigationPanel.tsx` — `collapsed` initial value `true`. The whole navigation panel is
  `null` below the mobile breakpoint.
- Also `usePassThroughWheelEvents(ref)` on the panel — the minimap must not eat wheel events.

**[inferred]** The convention set is: collapsed by default, click-to-jump with a ~320 ms ease,
drag-the-rect, and a click/drag threshold so a click doesn't cancel its own animation. If linsae's dot
tier *is* the minimap, then "click to jump" becomes "click a dot at dot tier → animate to card tier
centred on it", which is the same interaction expressed through the tier switch. That is a genuinely
elegant unification and it is what the vision is reaching for — but note it needs the 0.3–1.0 s
animated camera move to work, which does not exist yet (`useCanvasCamera` has no tweening).

---

## Q9 — Transition mechanics

### Does ADR 0019's guardrail extend to the canvas?

**Textually, no. Mechanically, yes. [verified text + inferred application]**

ADR 0019's guardrail is scoped by its own words (`adrs/0019-motion-animation-library.md`):

> "**No `layout` / `layoutId` shared-element projection inside the `@tanstack/react-virtual` feed.**
> The feed's rows are positioned with `transform: translateY(...)`; Motion's projection re-measures
> and applies counter-transforms each frame and fights that, and it silently no-ops on
> async-inserted rows (TanStack virtual #693)."

The stated mechanism is "rows positioned with `transform`" + "projection re-measures and applies
counter-transforms each frame". The canvas world container is
`translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`
(`CanvasStage.tsx:1734-1736`) and each card is `transform: translate(${x}px, ${y}px)`
(`NoteCard.tsx:179`) — **strictly worse** for projection than the feed, because there is a *scale* in
the ancestor chain as well as a translate. **The guardrail should be restated in the semantic-zoom
spec as covering the canvas explicitly**, with this as the reason. Today the canvas uses no `motion`
components at all (verified by grep: only `AnimatePresence mode="wait"` at the App level, wrapping the
whole stage).

### What `motion` actually offers, verified against the installed version

`motion@12.40.0`, `react@19.2.6` **[verified by reading `node_modules`]**:

- **`<AnimateView>` (React component) is NOT available.** Not exported from
  `node_modules/motion/dist/cjs/react.js`.
- **`animateView()` (imperative) and `ViewTransitionBuilder` ARE exported.**
- Current Motion docs describe `AnimateView` as "a 3kb component built on Motion's `animate()`
  function and **React's `ViewTransition` component**" and `animateView` as wrapping "the browser's
  native View Transition API" (context7 `/websites/motion_dev`, `motion.dev/docs/animate-view`,
  `motion.dev/docs/react-animate-view`).

**Do not plan on either. [inferred]** ADR 0018 already rejected the View Transitions API because it
"freezes during the async DOM-update callback". A tier swap on a canvas happens *during* a live
wheel gesture; freezing the document for the duration of a snapshot+update is categorically wrong
there. Adopting `AnimateView` would additionally require a `motion` bump and React's experimental
`ViewTransition`.

### The right mechanism

**[inferred, and it is what the docs support]**

**Cross-fade two simultaneously-mounted representations by opacity. Do not morph, and do not
unmount-then-mount.**

- Motion's own default for `AnimateView` is a crossfade: "By default, `AnimateView` animates elements
  using the browser's default opacity animation" — i.e. even the purpose-built API's default answer
  to "swap representation" is *opacity*, not morph **[verified quote, inferred application]**.
- `AnimatePresence` with a `key` change is the documented "swap one thing for another" idiom
  (context7: "Changing the `key` prop of a single child within `AnimatePresence` triggers a re-mount,
  enabling transition animations between states") — but it **remounts**, which is precisely the
  Obsidian `updateBreakpoint()` failure (§Q2) and the thing ADR 0033 spent the v0.4 budget avoiding.
- The dot and title representations do not live in DOM at all under the §4 recommendation — they are
  underlay draws. So the cross-fade is *not* a React problem: it is `ctx.globalAlpha` on the underlay
  layer plus `opacity` on the DOM card layer, both driven by one scalar computed from `zoom` across
  the band (exactly tldraw's `modulate(z, [min, mid], [0, 1])` grid pattern). This needs **no motion
  API at all**, respects `prefers-reduced-motion` trivially (snap instead of ramp), and cannot thrash
  mounts.
- Keep DOM cards mounted through the band and fade them; only unmount below the band's floor. The
  existing keep-alive LRU (`KEEP_ALIVE_SIZE = 32`, `CanvasStage.tsx:205`) already models this.
- If a card⇄dot *morph* is ever wanted (the card visually shrinking into its dot), do it on the
  underlay as an interpolated rect→dot, not as a DOM layout animation.

DigitalRune's warning applies to the cross-fade band: "The workload increases during transitions. Two
models need to be rendered instead of one" — so keep the band narrow enough that double-render is
short, and remember that during the band the DOM card layer is still mounted **[verified quote]**.

---

## Q10 — The semantic-consistency invariant

### Is there prior art or a name?

**No exact name found.** The closest things in the literature, in decreasing order of fit:

1. **Furnas 1997, "Effective View Navigation"** (CHI '97, 367–374) — the requirement that "all views
   contain good residue of all nodes", i.e. every view must carry scent of everything reachable from
   it. This is the same *shape* of constraint (an invariant relating what is visible in one view to
   what is reachable from it) but it is about *scent*, not *persistence*. **[inferred from secondary
   summary; the primary paper was not read in this pass.]**
2. **Jul & Furnas 1998, critical zones** — "a visual demarcation of regions that are guaranteed to
   yield further information when zoomed" (quoted in §Q1). This is the *converse* guarantee: if you
   see a marked region, zooming in will pay off. Arguably a stronger and more useful contract than
   linsae's, because it is about the *user's expectation* rather than the renderer's bookkeeping.
   **[verified.]**
3. **Cartographic generalization** has an analogous informal rule (a feature labelled at scale *z*
   stays labelled at larger scales), but I found **no citable formal statement** of it. MapLibre does
   *not* enforce it — its placement is per-frame greedy and a label can genuinely disappear as you
   zoom in if a higher-priority label takes the space. **[verified by reading `placement.ts`;
   the absence is the finding.]**

**So: the literature does not name this invariant, and the one production system with the closest
analogue (MapLibre) deliberately does not honour it.**

### The invariant as written is ambiguous, and the ambiguity is load-bearing

`src/renderer/src/canvas/lod.ts:1-6` **[verified]**:

> "Invariant recorded there: anything visible at a tier persists at all deeper tiers."

`docs/specs/v0.4-canvas-mvp.md` §12 **[verified]**:

> "the semantic-consistency invariant (visible at a tier ⇒ visible at all deeper tiers) is recorded
> there"

`adrs/0032-lod-seam-content-visibility-retirement.md:32-33` repeats it verbatim.

**"Deeper" is never defined.** Two readings, and they lead to opposite specs:

- **Reading A — "deeper" = more zoomed in (card is deepest).** Then: anything you can see as a dot,
  you must be able to see as a card. With 438 notes and 4 placed, the dot tier showing all 438 means
  434 notes must acquire card-tier positions — which is exactly the whole-vault card-tier
  auto-scatter that the vision forbids (`docs/canvas-vision.md:54-55`, principle 6: "The root canvas
  begins empty; nothing is auto-seeded. Whole-vault projection belongs to the far-zoom dot tier, not
  to card-tier auto-scatter.") and that the spike graded a **24–30 fps FAIL** (issue #96 body).
  **Reading A is unsatisfiable given the rest of the vision.**
- **Reading B — "deeper" = further zoomed out (dot is deepest).** Then: anything you see as a card
  must also appear as a dot. Trivially satisfiable, and it is the useful guarantee: zooming out never
  loses anything, so the dot tier is a complete index. This is what makes "the dot tier is the
  minimap" true.

**Reading B is almost certainly what was meant** and it is the one that composes with the vision. But
it must be written in words. Suggested replacement wording for `lod.ts` **[my proposal]**:

> Zooming **out** never removes information: every entity rendered at a nearer tier is also rendered
> (possibly reduced) at every farther tier. Zooming **in** may reveal entities that had no nearer-tier
> representation — those are *promotions*, and each one needs a defined promotion rule.

### What Reading B costs

**[inferred]** It forces the dot tier to be the **superset** surface. Combined with
`docs/canvas-vision.md:119-121` ("notes without manual positions get computed positions *here*, not
on the card tier"), that means:

- The dot tier renders **438** dots (all notes), not 4. Trivially inside the measured 10k budget.
- Those 434 computed positions must be **stable across sessions**, or the "minimap" lies: a note that
  was top-left yesterday must be top-left today, or spatial memory — the entire product thesis — is
  broken. Options: (a) persist them as `arrangement_id != 'manual'` rows, which activates the dormant
  key that principle 4 keeps dormant and re-opens #96; (b) derive them deterministically from a
  stable key (id hash → position, or created_at → a spiral/timeline), which persists nothing and is
  stable by construction. **(b) is the cheaper answer and does not touch the schema — recommend it.**
- Zooming **in** on one of those 434 is a promotion event with no defined rule today. The minimum
  honest behaviour: at card tier, computed-position notes are **not** rendered, and clicking one at
  dot tier offers "place it here" (which writes a real `'manual'` row) or "open thread". That is a
  new interaction and belongs in the spec, not the plan.

---

## Contradictions and corrections found

Listed because the brief asked for these specifically.

1. **`docs/canvas-vision.md:121-122`** — "Spike says canvas-2D handles 10k dots at 60 fps; WebGL not
   needed at this scale." **True but under-specified.** The measured primitive was `fillRect` of a
   2 × 2 px axis-aligned rect with a per-dot screen-space cull and one `fillStyle` for the whole loop
   (`scripts/spike-canvas/page/dots.js:31-38`). It is not evidence for arcs (linsae's own #124: 5.4 fps),
   not evidence for per-dot colour, and **not evidence for the title tier**, where the expensive
   primitive is text and nothing has been measured. The sentence should be narrowed, and "WebGL not
   needed" should be scoped to the dot tier.

2. **`src/renderer/src/canvas/CanvasStage.tsx:228-231`** — the `SYNTHETIC_DOT_COUNT` TSDoc says "Big
   enough to stress the **single-batch arc fill**." The implementation at `:685` is `fillRect`, and
   the sibling TSDoc at `:647-651` explicitly explains why arc was rejected. **The `:229` comment is
   stale** — it describes the pre-#124 implementation. One-line fix; qualifies as a documentation nit
   under the inline-fix gate.

3. **`src/renderer/src/canvas/CanvasStage.tsx:647-651`** — "Why fillRect, not a batched
   `beginPath()`/arc/`fill()`" attributes the 5.4 fps result to batching. **The measurement changed
   three variables at once** (arc vs rect, no-cull vs cull, rebuild-per-frame vs reuse), so the
   conclusion "batched `Path2D` loses" is not supported. tldraw's production minimap
   (`MinimapManager.ts:198-256`) is a batched `Path2D` of `rect()`s, **cached across frames** by a
   reactive computed, filled with two calls. The comment should say what was actually established:
   *rebuilding 10k arc subpaths per frame with no cull* loses.

4. **`src/renderer/src/canvas/lod.ts:4` / `docs/specs/v0.4-canvas-mvp.md` §12 / ADR 0032:32-33** —
   the semantic-consistency invariant's "deeper" is undefined, and the two readings give opposite
   specs, one of which is unsatisfiable given vision principle 6. See §10. **This is the most
   important correction in this document** because the milestone's scope depends on which reading
   wins.

5. **`docs/canvas-vision.md:28-29`** — "a separate minimap widget is permanently ruled out." The
   empirical literature **supports** this on performance grounds (Hornbæk et al. 2002: overview
   *increased* task time when semantic zoom was on; recall was better without it) but **contradicts
   it on preference grounds** (participants preferred the overview anyway; Nekrasovski et al. 2006
   agreed). The word "permanently" is doing work the evidence does not fully support. The survey's own
   recommendation is "offering users control over whether to display the overview" — which is what
   tldraw ships (collapsed by default, `useLocalStorageState('minimap', true)`).

6. **ADR 0032's framing of `content-visibility` as *the* cautionary tale** is right about
   `content-visibility` and should not be generalised. `will-change: transform` has the **opposite**
   sign under animated scale — it *prevents* per-frame re-raster (Chrome ≥53 re-rasters on scale
   change without it), at the cost of memory and sharpness. Reading the spike as "compositing hints
   are bad on the canvas" would be a wrong generalisation from a correct measurement. See §4.

7. **`docs/canvas-vision.md:121`** — "this is where issue #96's overview direction lands if its
   trigger fires." Per the brief, the trigger **has** fired: 4 placed notes against a pre-registered
   threshold of ~20 (issue #96: "if fewer than ~20 notes have manual positions, the thinking-space
   hypothesis is falsified → promote the overview direction"). **[The 4-of-438 figure is taken from
   the task brief; I did not independently query the vault DB.]** The conditional in the vision should
   become a statement, and #96 should be updated or closed by this milestone per CLAUDE.md's
   retirement rule.

---

## What this implies for linsae

### The seam in `lod.ts` is nearly right; it needs one more input, not a rewrite

Today (`src/renderer/src/canvas/lod.ts`, 17 lines) **[verified]**:

```ts
export type LodTier = 'card' | 'title' | 'dot'
export const TIER_THRESHOLDS = { title: 0.5, dot: 0.15 } as const
export function tierForZoom(zoom: number): LodTier { … }
```

The minimum honest additions, in dependency order **[inferred]**:

1. **A blend factor, not just a tier.** `tierBlend(zoom): { tier, next, t }` where `t ∈ [0,1]` is the
   cross-fade position inside a band. This is what makes §9's opacity cross-fade expressible without
   scattering `modulate()` calls. tldraw's grid is the model.
2. **A stabilised zoom input.** Either `tierForZoom` takes an already-frozen value, or a new
   `useTierZoom(camera.zoom, isMoving)` hook does the freeze. Prefer the latter — `lod.ts` should stay
   pure (it is node-env-testable today, `lod.test.ts`).
3. **Direction is already free.** `tierForZoom` is a pure function of one number; adding hysteresis
   would make it stateful and break that. **Keep the purity**: put hysteresis (if it is ever needed)
   in the hook, and keep `TIER_THRESHOLDS` as the single source of truth ADR 0032 promised.

### Concrete wiring points that already exist

| Need | Already in the repo | File:line |
|---|---|---|
| freeze LOD input during gesture | `isMoving`, 120 ms settle | `useCanvasCamera.ts:29, 93-97` |
| tier switch unmounts cards | `if (tier === 'dot') return EMPTY` | `CanvasStage.tsx:1642-1647` |
| screen-constant canvas text | `drawTypePill` | `CanvasStage.tsx:276-307` |
| flat position buffer | `dotPositions: Float32Array` | `CanvasStage.tsx:632-640` |
| dot draw + cull | `dotsLayer` | `CanvasStage.tsx:661-689` |
| generic underlay layer contract | `UnderlayLayer.draw(ctx, camera)` | `CanvasUnderlay.tsx:31-37` |
| on-demand rAF (no idle wakeups) | dirty flag + single pending frame | `CanvasUnderlay.tsx:95-179` |
| inflated-rect spatial query | `CardSpatialIndex.search` | `spatial-index.ts:54-57` |
| keep-alive LRU (no remount thrash) | `KEEP_ALIVE_SIZE = 32` | `CanvasStage.tsx:205` |
| dev tier override + 10k dots | `dev-lod.ts` | `dev-lod.ts:25-39` |
| perf gates incl. a `dot` phase | harness | `docs/harness/canvas-perf.md` |

**The seam has held.** Nothing above needs to be undone; the milestone is genuinely a fill-in, which
is what ADR 0032 was for.

### The 4-of-438 measurement changes the shape of the milestone

**[inferred]** If the dot tier is the primary surface rather than the deepest zoom-out of a card
surface, then:

- **The zoom clamp is the first thing to move.** Today `[0.5, 2.0]` (ADR 0032:34-36: "The user zoom
  clamp `[0.5, 2.0]` sits its floor exactly on the title-tier threshold, so normal use can never
  leave card tier"). Shipping semantic zoom *is* lowering that floor. With `TIER_THRESHOLDS.dot =
  0.15` and a 438-note field, the floor needs to reach at least ~0.1 for the whole field to fit
  (`SYNTHETIC_DOT_SPREAD = 10_000` at `baseZ 0.1` is the spike-validated framing —
  `CanvasStage.tsx:233-242`). **This is a one-line change with milestone-sized consequences** — every
  Esc-cascade, hit-test, picker and drag path now has a dot-tier case. Issue #18's re-audit obligation
  fires here.
- **`fit` gains a real job.** Today it "frames all cards (no-op at zero)"
  (`docs/specs/v0.4-canvas-mvp.md` §14). With 438 dots it becomes the primary orientation gesture and
  the answer to desert fog (Bederson's mitigation: make it hard to be nowhere).
- **Issue #114 must be closed by this milestone** — "clear `editingId` when the edited card is
  unplaced/removed **or dot tier is forced mid-edit**". It is currently reachable only via the dev
  HUD; shipping the tier makes it a real bug. CLAUDE.md's retirement rule applies.
- **Issue #96 must be resolved or explicitly re-affirmed**, since its pre-registered trigger has
  fired and this milestone is the thing it named. Note its warning holds either way: "a whole-vault
  computed arrangement at card tier is the spike's 24–30fps FAIL case … so it drags the LOD dot/title
  tiers into scope." Reading B of the invariant (§10) is what keeps the whole-vault projection *out*
  of card tier and therefore out of that FAIL case.
- **Deterministic computed positions, not persisted ones** (§10) keep `arrangement_id` dormant and
  principle 4 intact.

### Perf gates this milestone owes

**[inferred]** The existing harness has `churn`, `steady`, `dot`. It needs:

- a **`title`** phase (p95 ≤ 18 ms with N synthetic titles at zoom ~0.3) — the genuinely unmeasured
  risk;
- a **zoom-sweep** phase (the existing churn/steady pan at zoom 1, so they cannot see re-raster cost
  at all — `docs/harness/canvas-perf.md` §Three phases), which is the only way to measure whether
  `will-change: transform` on the world container helps;
- a **band** phase that parks the camera inside a cross-fade band, where both representations render
  simultaneously (DigitalRune's "two models instead of one").

---

## Open questions

1. **Which reading of the semantic-consistency invariant?** (§10.) Blocking — the spec cannot be
   written without it, and Reading A is unsatisfiable against vision principle 6.
2. **Does the dot tier render all 438 notes, or only placed ones?** Product call. Reading B plus
   `docs/canvas-vision.md:119-121` implies all 438; the vision's "curated start" instinct pulls the
   other way. Note that "all 438" is what makes the dot tier a minimap.
3. **Deterministic-derived vs persisted computed positions** for the 434 unplaced notes. I recommend
   derived (no schema change, stable by construction, keeps `arrangement_id` dormant), but this is a
   design decision with a durable consequence — probably an ADR.
4. **What does clicking an unplaced note's dot do?** No rule exists. Candidates: place-it-here, open
   thread, open in feed. Interacts with #114.
5. **`fillText` cost at ~438 labels/frame on the reference machine.** Unmeasured; needs a harness
   phase before the title tier's design is fixed. If it fails, the escalation is an offscreen-canvas
   label atlas keyed by (title, dpr).
6. **Does `will-change: transform` on the world container during `isMoving` actually help?** The
   mechanism says yes (Chrome ≥53 re-raster), the memory arithmetic says it must be gesture-scoped,
   and nothing in the repo has measured it. Should be its own experiment, not folded into semantic
   zoom.
7. **Cross-fade band width and hysteresis ratio.** No source prescribes numbers for a zoom-driven 2D
   UI. Needs a dogfooding call after freeze-during-gesture is in.
8. **Is `rbush-knn` ever wanted?** Not for click hit-testing (§6). Possibly for a keyboard "jump to
   nearest note" command. Deferred.
9. **Does the tier switch need to survive a restart?** v0.7 persists the camera
   (`useCanvasCamera` → `canvas:setState`), so it already does implicitly — but a user who quit at
   dot tier will reopen at dot tier with no cards, which may read as "my canvas is empty". Worth a
   deliberate decision.

---

## Sources

**Read as primary source (code):**
- tldraw `main`, fetched 2026-08-02: `packages/editor/src/lib/options.ts`,
  `packages/editor/src/lib/editor/Editor.ts`,
  `packages/editor/src/lib/components/default-components/DefaultGrid.tsx`,
  `packages/editor/src/lib/editor/managers/SpatialIndexManager/SpatialIndexManager.ts`,
  `packages/tldraw/src/lib/shapes/shared/useEfficientZoomThreshold.ts`,
  `packages/tldraw/src/lib/shapes/shared/defaultStyleDefs.tsx`,
  `packages/tldraw/src/lib/shapes/note/NoteShapeUtil.tsx`,
  `packages/tldraw/src/lib/ui/components/Minimap/MinimapManager.ts`,
  `packages/tldraw/src/lib/ui/components/Minimap/DefaultMinimap.tsx`,
  `packages/tldraw/src/lib/ui/components/NavigationPanel/DefaultNavigationPanel.tsx`,
  `apps/docs/content/sdk-features/performance.mdx`,
  `apps/examples/src/examples/use-cases/many-shapes/README.md` — https://github.com/tldraw/tldraw
- Excalidraw `master`: `packages/common/src/constants.ts`,
  `packages/excalidraw/renderer/staticScene.ts` — https://github.com/excalidraw/excalidraw
- MapLibre GL JS `main`: `src/symbol/grid_index.ts`, `src/symbol/collision_index.ts`,
  `src/symbol/placement.ts`, `src/ui/map.ts` — https://github.com/maplibre/maplibre-gl-js
- `rbush@4.0.1` README (`node_modules/rbush/README.md`); `rbush-knn@4.0.0` README + npm metadata —
  https://github.com/mourner/rbush, https://github.com/mourner/rbush-knn
- `motion@12.40.0` exports (`node_modules/motion/dist/cjs/react.js`), `react@19.2.6`

**Read as primary source (papers/specs):**
- Cockburn, A., Karlson, A., Bederson, B. B. (2008). *A review of overview+detail, zooming, and
  focus+context interfaces.* ACM Computing Surveys 41(1), Article 2. —
  https://dl.acm.org/doi/10.1145/1456650.1456652 ·
  PDF: https://faculty.cc.gatech.edu/~stasko/7450/Papers/cockburn-surveys08.pdf
- Christensen, J., Marks, J., Shieber, S. (1995). *An Empirical Study of Algorithms for Point-Feature
  Label Placement.* ACM TOG 14(3), 203–232. — https://dl.acm.org/doi/10.1145/212332.212334 ·
  PDF: https://www.eecs.harvard.edu/~shieber/Biblio/Papers/tog-final.pdf
- W3C WCAG 2.2, SC 2.5.8 Target Size (Minimum) and SC 2.5.5 Target Size (Enhanced) —
  https://www.w3.org/TR/WCAG22/#target-size-minimum ·
  https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- MDN, `will-change` — https://developer.mozilla.org/en-US/docs/Web/CSS/will-change
- Chrome for Developers, *Re-rastering composited layers on scale change* —
  https://developer.chrome.com/blog/re-rastering-composite
- Chromium, *How cc Works* —
  https://chromium.googlesource.com/chromium/src/+/main/docs/how_cc_works.md

**Cited via the Cockburn survey, not read directly:**
- Perlin, K., Fox, D. (1993). Pad. · Bederson, B. B. et al. (1996). Pad++. · Bederson et al. (2000).
  Jazz. · Bederson et al. (2004a). Piccolo. · Pietriga (2005). ZVTM.
- Furnas, G., Bederson, B. (1995). *Space-scale diagrams.* · Furnas, G. (1986). *Generalized fisheye
  views.* · Furnas, G. (1997). *Effective view navigation.* CHI '97, 367–374.
- Jul, S., Furnas, G. (1998). *Critical zones in desert fog: Aids to multiscale navigation.* UIST '98.
- Hornbæk, K., Bederson, B., Plaisant, C. (2002). *Navigation patterns and usability of zoomable user
  interfaces with and without an overview.* TOCHI. — https://dl.acm.org/doi/abs/10.1145/586081.586086
- Van Wijk, J., Nuij, W. (2004). · Bederson & Boltman (1999). · Nekrasovski et al. (2006).

**Secondary / community (explicitly weaker):**
- DigitalRune, *Level of Detail (LOD)* —
  https://digitalrune.github.io/DigitalRune-Documentation/html/b320aebd-46a0-45d8-8edb-0c717152a56b.htm
- three.js issue *LOD: Consider adding hysteresis option* —
  https://github.com/mrdoob/three.js/issues/14565 · Godot *Add LoD hysteresis* —
  https://github.com/godotengine/godot/issues/6375
- Qbject, *obsidian-canvas-performance-patch* README —
  https://github.com/Qbject/obsidian-canvas-performance-patch/blob/main/README.md
- Obsidian forum threads
  [78352](https://forum.obsidian.md/t/how-do-i-stop-canvas-card-titles-from-disappearing-when-zoomed-far-out/78352),
  [57181](https://forum.obsidian.md/t/stop-content-of-note-from-being-hidden-when-canvas-is-zoomed-out/57181)
- Mirko Sertic (2015), *Supercharging HTML5 Canvas Text Performance* —
  https://www.mirkosertic.de/blog/2015/03/tuning-html5-canvas-filltext/ (**2015, Firefox-skewed**)
- Figma blog: [Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/),
  [Figma Rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)
- Milanote help, [Zoom in/out](https://help.milanote.com/en/articles/1721940-zoom-in-out) · Prezi
  support, [How to use zoom in Prezi Present](https://support.prezi.com/hc/en-us/articles/360003498793-How-to-use-zoom-in-Prezi-Present)
- Microsoft WinUI, [Semantic Zoom](https://learn.microsoft.com/en-ca/windows/apps/design/controls/semantic-zoom)
  (different sense of the term — terminology warning only)

**In-repo sources cited:** `docs/canvas-vision.md` · `docs/specs/v0.4-canvas-mvp.md` §3 §12 §13 §14 ·
`docs/research/2026-06-12-canvas-spike-results.md` · `docs/harness/canvas-perf.md` ·
`adrs/0018-*`, `adrs/0019-motion-animation-library.md`,
`adrs/0032-lod-seam-content-visibility-retirement.md`,
`adrs/0033-motion-lod-mount-churn-amortization.md`, `adrs/0041-*` ·
`src/renderer/src/canvas/{lod.ts,CanvasStage.tsx,CanvasUnderlay.tsx,useCanvasCamera.ts,spatial-index.ts,NoteCard.tsx,dev-lod.ts}` ·
`scripts/spike-canvas/page/dots.js` · GitHub issues utof/linsae#18, #96, #109, #110, #112, #114, #124
