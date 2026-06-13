# 0026 — Overlay render: parse-to-scene → React inline SVG (never inject stored markup, never `<img>` the sidecar)

Status: accepted (v0.2.5)

## Context

The annotation sidecar is an SVG file on disk served by the loopback shell at
`/_media/…`. There are two naive ways a component could render it:

1. `<img src={mediaUrlFromPath(overlay_path)}>` — load it as an image.
2. Fetch the SVG text and inject the markup directly into the DOM via `dangerouslySetInnerHTML`
   or similar.

Both are wrong for this use case.

## Decision

`SceneSvg` (`src/renderer/src/ink/SceneSvg.tsx`) always renders the overlay as **inline React
SVG** constructed from a typed `Scene` object. The render pipeline is:

```
fetch(mediaUrlFromPath(overlay_path)) → parseScene(text) → <SceneSvg scene={…} />
```

`parseScene` reads only `data-*` attributes and ignores the stored `<path d>` geometry
(recomputed via `strokeToPath`). Stored markup is never injected.

The decision rests on three independent legs, any one of which would be sufficient alone:

1. **Interactivity.** An SVG loaded as an `<img>` is inert — its elements cannot receive
   pointer events. The editor requires per-element `onPointerDown` / `onPointerEnter` handlers
   (eraser tool hit-testing; `SceneSvg.tsx:82-89`). Inline SVG is not optional for the editor.

2. **XSS boundary.** The sidecar is stored locally but is user- and hand-editable. Injecting
   stored markup would be an XSS vector. Reconstructing the scene from typed `data-*` attributes
   via `parseScene` (defensive, never throws, skips unknown elements) means no stored markup
   ever reaches the DOM as HTML/SVG markup.

3. **Crispness.** Inline strokes re-tessellate via `getStroke` at the rendered container size
   instead of scaling a fixed raster. `strokeToPath` is called on every render with the current
   `Stroke.points`; the outline adapts to any container without pixelation.

**Honesty note — the dropped `foreignObject`/`<img>` claim:** an earlier draft of the spec
included a fourth rationale: "`foreignObject` doesn't render when the SVG is loaded via
`<img>`." That claim is **false in Chromium** — `dom-to-image` and similar tools demonstrate
that HTML-in-SVG does render via `<img>` in Chromium; only Safari blocks it. Since linsae runs
in Electron (Chromium), this claim would have been incorrect. It was explicitly dropped from the
spec before implementation. The decision stands on the three legs above.

The sidecar (`<attachmentId>.svg`) is **storage only** — a portable file for human inspection
and future tool compatibility. It is never the render source.

## Alternatives

- **`<img src={mediaUrlFromPath(overlay_path)}>` (load the sidecar as an image)** — rejected:
  an image-loaded SVG is inert, so its elements cannot receive the pointer events the
  eraser/edit tools require (leg 1), and it scales as a fixed raster instead of re-tessellating
  crisply (leg 3).
- **Inject the fetched SVG text via `dangerouslySetInnerHTML` / markup injection** — rejected:
  the sidecar is user- and hand-editable, so injecting stored markup is an XSS vector (leg 2).
  Reconstructing the scene from typed `data-*` attributes keeps stored markup out of the DOM.

## Consequences

- `useOverlayScene` (`src/renderer/src/annotate/useOverlay.ts:63`) fetches with
  `{ cache: 'no-store' }` because the sidecar path is stable across edits and the shell emits
  no HTTP validators (`http-shell.ts:158`) — without `no-store` the browser would serve a
  stale cached copy after a save.
- The Rail's read-only `<SceneSvg>` is rendered without pointer handlers, so the root `<svg>`
  receives `pointer-events: none` and never swallows clicks meant for the frame beneath
  (`SceneSvg.tsx:68`).
- Any future export / share flow that needs a flat raster (e.g. copy-to-clipboard) must
  composite the base PNG + sidecar itself — `SceneSvg` does not provide a `toBlob` / canvas
  path. This is acceptable YAGNI; the sidecar's standalone viewability covers the human-readable
  case.

## Sources

- `src/renderer/src/ink/SceneSvg.tsx` — inline SVG renderer, three-leg comment at top
- `src/renderer/src/ink/svg.ts` — `parseScene` (data-* only, ignores `<path d>`)
- `src/renderer/src/annotate/useOverlay.ts:63` — fetch + parse hook, `no-store` rationale
- `docs/specs/v0.2.5-screenshot-annotation.md` §"Presentational renderer", §"ADRs to write" 0026
