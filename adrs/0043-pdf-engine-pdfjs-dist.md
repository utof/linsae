# 0043 — PDF rendering engine: `pdfjs-dist` (slim slice), EmbedPDF tracked as v2

Status: accepted (v0.6)

## Context

v0.6 (`docs/specs/v0.6-pdf-slim-slice.md`) ships the slim PDF slice: read a PDF in a right-dock
content pane and drag a text excerpt onto the canvas as a note with a hybrid `source_locator`
back-link. This requires a PDF rendering engine inside the Electron app.

The research at `docs/research/2026-27-06-pdf-libs-and-architecture.md` surveyed the options as of
June 2026. This ADR records the engine decision and the v2 alternative, so a future milestone
swapping engines does not re-litigate the trade-offs.

## Decision

**Use Mozilla `pdfjs-dist` v6 (Apache-2.0)**, rendered directly in the sandboxed renderer process
via a thin in-house React component (`src/renderer/src/pdf/PdfReader.tsx`).

- **NOT** a third-party React wrapper (`react-pdf` / `@react-pdf-viewer/core` / react-pdf-viewer.dev's
  "React PDF"). `react-pdf` (wojtekmaj, MIT) is a thin "display PDFs like images" wrapper that
  abstracts away the text-layer control the excerpt-drag needs. The two `react-pdf-viewer` products
  are commercial (disqualified on licensing for a solo-dev OSS-adjacent app).
- **NOT** a Chrome `<webview>` with the built-in PDF viewer. That viewer cannot expose selected text
  + rect to the app (separate locked-down browsing context), which kills excerpt-drag. The YouTube
  `<webview>` precedent (ADR 0016) exists only because the IFrame needs a real `http://` origin; a
  local PDF has a different threat model and gains nothing from a webview.
- **NOT** a commercial SDK (PSPDFKit/Nutrient ~$76k/yr average per Vendr; Apryse/Foxit similar).
  Disqualified on cost and licensing.
- **NOT** mupdf.js (AGPL-3.0 or commercial). AGPL copyleft is a hard blocker for bundling into the
  shipping app. Flagged only as a possible future build-time text-extraction tool out-of-process
  (AGPL boundary unclear; not relied on).

## Security mitigations (CVE-2024-4367 class)

`isEvalSupported: false` is set in the `pdf.js` `getDocument` options. CVE-2024-4367 (arbitrary JS
execution via a crafted font, patched in pdf.js v4.2.67 / April 2024) requires `isEvalSupported:
true` (the pdf.js default) — the mitigation kills the eval-based font path. The existing baseline
(`sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` — `src/main/security.ts:42-53`) is
the backstop preventing XSS-in-renderer from becoming RCE. CSP keeps `script-src 'self'` (no
`unsafe-eval`); adds only `worker-src blob:` for the blob-wrapped same-origin pdf.js worker
(mozilla/pdf.js #9676). `will-attach-webview` stays YouTube-only.

## Alternatives considered

- **EmbedPDF** (MIT, PDFium-via-WASM, `@embedpdf/plugin-selection` `getFormattedSelection()` returns
  per-page `{pageIndex, rect, textLines}`). This is the standout newer entrant and the tracked v2
  alternative. Its selection API is materially better aligned with the excerpt-drag vision than
  hand-rolling pdf.js text-layer `getClientRects()` math, and PDFium's C++-to-WASM font parsing
  structurally avoids the CVE-2024-4367 JS-eval class. **Not chosen for v0.6** because: younger /
  less battle-tested than pdf.js (4.2k stars vs 20.9M weekly downloads), larger WASM binary,
  Electron 39 sandbox + strict CSP WASM load unverified, React 19 `peerDependencies` not directly
  confirmed. **Stage 3 spike** will verify these; if it clears, swap the engine — the
  `source_locator` shape and IPC surface (`docs/specs/v0.6-pdf-slim-slice.md` §3) are
  engine-agnostic by design.
- **pdf.js native editor layer** (FreeText/Ink/Highlight/Stamp/Signature editors) is an alternative
  for Stage 2 (PDF annotation) but stores into the PDF / its own model and would NOT reuse the
  context-free `ink/` module (ADR 0027) or round-trip to linsae's SVG sidecar. The vision's
  ink-reuse contract (canvas-vision §9) points to a custom overlay, not pdf.js's editor layer.

## Consequences

- **New dep:** `pdfjs-dist` (Apache-2.0, single package, no concerning runtime deps). Bundle
  impact ~1–2 MB core+worker, loaded on-demand when a PDF opens (not at app boot).
- **No native module / no ABI dance.** pdf.js is pure JS + a worker; existing `pnpm rebuild:electron`
  / `rebuild:node` unaffected.
- **React Compiler 1.0** (ADR 0006): the thin in-house component is compiler-safe by construction
  (pdf.js itself is framework-agnostic). A third-party wrapper's compiler compat is undocumented —
  another reason the research preferred the in-house wrapper.
- **Maintenance signal:** pdf.js ships roughly monthly, 461 contributors, 20.9M weekly npm
  downloads. Pin a current 6.x; track upstream for security releases. A dependabot/renovate config
  is out of scope for v0.6 but noted here.
- **The v2 (EmbedPDF) swap path is open:** the engine is encapsulated behind
  `src/renderer/src/pdf/PdfReader.tsx` + `usePdfDocument.ts` + `useExcerptCapture.ts`. A swap
  touches those three files + the worker config; the IPC surface, schema, and `source_locator`
  shape are unchanged.

## Sources

- `docs/research/2026-27-06-pdf-libs-and-architecture.md` §A (library comparison table), §F (security)
- `local_files/preresearch/2026-06-27-pdf-support-handoff.md` §11A (decision space)
- mozilla/pdf.js issue #9676 (worker blob wrapper, same-origin)
- Codean Labs CVE-2024-4367 disclosure (pdf.js font eval, patched v4.2.67)
- npmjs.com `pdfjs-dist` package page (v6.0.227, May 30 2026)
- `src/main/security.ts:42-53` (hardened webPreferences baseline)
- ADR 0008 (loopback HTTP shell — why `app://` was abandoned; PDF reuses the shell)
- ADR 0016 (YouTube `<webview>` — the precedent this ADR declines to extend to PDF)
- ADR 0027 (context-free `ink/` module — the Stage 2 reuse contract for PDF annotation)
