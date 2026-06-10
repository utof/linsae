# 0027 — Context-free `ink` module as the canvas-roadmap seam

Status: accepted (v0.2.5)

## Context

The long-term linsae roadmap includes a mind-map / spatial-canvas layer (referenced in
`v0.2-youtube-annotation.md` §Forward direction). The hard parts of a canvas — infinite zoom,
LOD, culling, externally-driven layout — do not exist in the v0.2.5 screenshot editor: the
drawing surface is a fixed 16:9 PNG.

This milestone is therefore a bounded, low-risk rehearsal of that future ink layer. The key
question is: when the canvas ships, must it rewrite or re-integrate stroke capture, SVG
serialization, and tessellation logic from scratch?

## Decision

All stroke/SVG logic is confined to `src/renderer/src/ink/`. Files under `ink/` import
**only `perfect-freehand` and DOM/React** — never from `thread/`, `feed/`, `lib/api`,
`shared/`, or any attachment/IPC code.

```
src/renderer/src/ink/
  types.ts        — Scene model (InkPoint, Stroke, TextBlock, SceneElement, Scene)
  stroke.ts       — strokeToPath, vendored _getSvgPathFromStroke
  svg.ts          — serializeScene / parseScene
  SceneSvg.tsx    — pure presentational renderer
```

The **import boundary is the contract**. Because `ink/` has no knowledge of attachments or IPC,
the future canvas can consume the exact same module unchanged — it brings its own host
(attachment-free, IPC-free spatial canvas) and plugs in `SceneSvg` and `serializeScene` without
modification.

This boundary is enforced by review and will be enforced structurally by the future canvas
consumer: any import from `ink/` into attachment code signals that the boundary was crossed the
wrong way.

`AnnotatedFrame`, `AnnotateEditor`, and `useOverlay` live **outside** `ink/` (under `annotate/`)
precisely because they do know about attachments and IPC. They are the adapter layer, not the
ink layer.

## Alternatives

- **Colocate the stroke/SVG logic inside `annotate/`** — rejected: the future spatial canvas
  would then have to drag in (or fork) attachment/IPC-aware code to reuse the stroke pipeline,
  defeating the rehearsal. A context-free module is consumed unchanged.
- **Enforce the boundary with a lint rule (`eslint-plugin-boundaries` or similar)** — deferred
  (YAGNI): the boundary is enforced by review now; a structural rule can be added if violations
  appear (see Consequences).

## Consequences

- `ink/` has no dep on Electron, IPC, React Query, or any linsae domain type other than the
  types it defines. `vitest --environment node` can test `svg.ts` and `stroke.ts` without a
  DOM shim. `SceneSvg.tsx` requires happy-dom (React component), but no mock API.
- The canvas roadmap inherits a tested, typed, zero-dependency stroke pipeline on day one — no
  port or rewrite needed.
- **Enforcement is by convention + review, not a linter rule.** A future task could add an
  `eslint-plugin-boundaries` or similar rule if violations are observed; the decision was to
  keep the toolchain minimal for now (YAGNI).
- `perfect-freehand` is the one external dep `ink/` pulls in. Its maintenance risk is documented
  in ADR 0025.

## Sources

- `src/renderer/src/ink/types.ts` — module boundary documented in TSDoc
- `src/renderer/src/ink/stroke.ts:4` — "ONLY file in ink/ that imports perfect-freehand"
- `docs/specs/v0.2.5-screenshot-annotation.md` §"The ink module — context-free", §"Strategic framing"
- ADR 0025 — overlay format and perfect-freehand maintenance risk
