# 0025 — Drawing overlay format: perfect-freehand + points-embedded SVG sidecar, keyed by attachment id

Status: accepted (v0.2.5)

## Context

v0.2 captured immutable PNGs and provisioned `attachments.overlay_path TEXT` for a future
drawing layer. v0.2.5 fills that gap. The overlay must be:

1. **Re-editable** — individual strokes can be moved, recolored, erased, and re-tessellated
   after saving. A flattened bitmap cannot meet this goal.
2. **Standalone-viewable** — the sidecar should open in a browser tab and render legibly
   without a running app.
3. **Dumb-overlay-composable** — any `<img>` host can layer the file on top of the PNG using
   CSS `position: absolute` without parsing it.
4. **Keyed correctly under content-hash dedup** — `persistCapture` deduplicates identical PNG
   bytes: two captures of the same frame share one `base_sha256` / one file, but get distinct
   `attachments` rows (ADR 0009 §Consequences; spec §Cardinality). Two such attachments can
   carry different annotations, so a sha256-keyed sidecar would clobber one annotation with the
   other. The sidecar must be keyed by the attachment `id` (unique per row).

The sidecar path is therefore:
```
<userData>/attachments/<yyyy>/<mm>/<attachmentId>.svg
```
placed in the same `yyyy/mm` directory as the base PNG so the last-3-segment
`mediaUrlFromPath` contract (`src/renderer/src/lib/media-url.ts`) applies unchanged.

## Decision

Use a **standalone SVG sidecar** serialized by `ink/svg.ts` (`serializeScene`) with:

- One `<path>` per stroke carrying **both** the rendered outline `d` (for standalone viewing)
  **and** `data-points="{x},{y},{p} …"` (raw input points — the re-editable source of truth).
- One `<foreignObject>` per `TextBlock` with `data-*` attributes for all fields.
- `viewBox="0 0 {width} {height}"` in image-pixel space matching `attachment.width_px` /
  `height_px`.

Stroke outlines are computed by `getStroke` from the `perfect-freehand` package (MIT,
`steveruizok/perfect-freehand`, last push 2026-04-13 — verified via `gh api` this milestone).
`getSvgPathFromStroke` is not exported by the package; the ~30-line helper from the README is
vendored into `ink/stroke.ts:35` with a `@see` citation.

On parse (`parseScene`), the stored `<path d>` geometry is **ignored and recomputed** from
`data-points` — this is also the XSS boundary (ADR 0026).

**Sidecar keying:** `persistOverlay` (`src/main/media/persist-overlay.ts:63`) derives the path
as `join(dirname(row.base_path), id + '.svg')`, ensuring two attachments that share a
`base_sha256` deduped PNG get distinct sidecars.

**Portability footnote:** the sidecar renders strokes and text in a browser. Non-browser SVG
consumers (Inkscape, macOS Quick Look) render `<path>` strokes but may not render
`<foreignObject>` text — do not promise universal rendering outside Chromium.

## Alternatives

| Option | Why not chosen |
|---|---|
| **Flatten-only (rasterize to PNG)** | Loses re-editability and the canvas-roadmap stroke model (the `ink` module is a rehearsal for the future spatial canvas — ADR 0027). |
| **tldraw** | License key required for production use + watermark on free tier; contributions paused January 2026. The scene format is also owned by tldraw, not us. |
| **Excalidraw** | Owns its scene; would require a second JSON sidecar alongside the SVG. Its export is an SVG snapshot, not a re-editable scene. |
| **Konva** | Canvas-first library; SVG is a conversion output, not a first-class format. No reuse on the canvas roadmap. |
| **Fabric.js** | Has native two-way SVG serialization (it is unfair to call SVG "a conversion" for Fabric). Lost on scene ownership (Fabric's object model encapsulates elements; we need our own typed `Scene`), uniform-width brush paths, and zero reuse on the canvas roadmap. **Flip condition:** if scope grows to shapes, arrows, or transform handles, Fabric becomes the right tool for this editor and this choice should be revisited at that point. |

## Consequences

- **Re-edit fidelity:** `parseScene` reconstructs every stroke's raw points from `data-points`
  and ignores `<path d>`, so re-tessellation at any container size is always exact.
- **perfect-freehand maintenance risk:** issue triage is slow; the "hot elbows" fast-stroke
  artifact is open. Mitigation: `perfect-freehand` is one pure, zero-dependency function
  (~200 LoC, MIT). Worst case: vendor the whole file into `ink/` (far cheaper than the
  react-virtuoso burn, ADR 0005).
- **SVG size:** typical screenshot markup is small (tens of strokes). `data-points` adds
  ~30 bytes/point. No compression needed at this scale.
- **Dedup correctness** is enforced by the integration test: two attachments sharing one
  `base_sha256` get distinct `<attachmentId>.svg` sidecars
  (`src/main/media/persist-overlay.ts` + integration suite).

## Sources

- `src/renderer/src/ink/svg.ts` — `serializeScene` / `parseScene`
- `src/renderer/src/ink/stroke.ts:35` — vendored `_getSvgPathFromStroke` + `strokeToPath`
- `src/renderer/src/ink/types.ts` — `Stroke`, `TextBlock`, `Scene`
- `src/main/media/persist-overlay.ts:63` — sidecar path derivation (attachment-id keyed)
- `docs/specs/v0.2.5-screenshot-annotation.md` §Sidecar identity, §"The ink module"
- ADR 0009 §Consequences — dedup row cardinality
- perfect-freehand README (vendored helper) — https://github.com/steveruizok/perfect-freehand#rendering
- perfect-freehand repo (MIT, last push 2026-04-13) — https://github.com/steveruizok/perfect-freehand
