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

**Pin pdf.js v6.x and do not downgrade.** CVE-2024-4367 (arbitrary JS execution via a crafted
font, disclosed April 2024, patched in v4.2.67) required `isEvalSupported: true` — a v4/v5
`getDocument` option that was the pdf.js default. **`isEvalSupported` was REMOVED in the v5→v6 major
API cleanup (PR #21245) and is NOT a v6 option** (verified via context7 `/mozilla/pdf.js` + pdf.js
v6.0.227 source, 2026-06-27 — `isEvalSupported` appears 0 times in the v6 `DocumentInitParameters`
typedef or `getDocument()` body). The eval-based font path was pruned with the option, so the v6
mitigation is structural, not opt-out. (Prior research at
`docs/research/2026-27-06-pdf-libs-and-architecture.md` instructed `isEvalSupported:false` — that is
a v6 no-op; the research doc is stale on this point and should be amended.)

The existing baseline is the primary mitigation: `sandbox:true`, `contextIsolation:true`,
`nodeIntegration:false` (`src/main/security.ts:42-53`) — the backstop preventing XSS-in-renderer
from becoming RCE. CSP keeps `script-src 'self'` (no `unsafe-eval`); adds only `worker-src blob:`
for the blob-wrapped same-origin pdf.js worker (mozilla/pdf.js #9676). `will-attach-webview` stays
YouTube-only. Smoke test must verify the blob worker boots under `sandbox:true` + the literal CSP.

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
  `src/renderer/src/pdf/PdfReader.tsx` + `usePdfDocument.ts` + `useExcerptCapture.ts` +
  `excerptState.ts` (the zustand pending-excerpt store). A swap touches those four files + the
  worker config; the IPC surface, schema, and `source_locator` shape are unchanged. Note: v6
  disposal is `loadingTask.destroy()` (NOT `PDFDocumentProxy.destroy()`, which PR #21245 removed);
  the main-process metadata path imports `pdfjs-dist/legacy/build/pdf.mjs` (`.mjs` not `.js` —
  v6 is ESM-only).

## Amendment (2026-06-28, v0.6): the renderer also uses the **legacy** build

The v0.6 Playwright-Electron smoke (`scripts/pdf-render-smoke.mjs` — the first real render; all prior
PDF tests were happy-dom) caught that `PDFPageProxy.render()` throws
`TypeError: ...getOrInsertComputed is not a function` in the target runtime. Root cause: `pdfjs-dist`
v6's **modern** build calls `Map.prototype.getOrInsertComputed` (TC39 "upsert", Stage 4 2026-01-20,
unflagged baseline **Chrome 145 / V8 14.5**) in both the renderer and worker realms; pinned
**Electron 39 = Chromium 142 / V8 14.2** lacks it. So the "**No native module / pure JS, just works**"
consequence above carries a caveat: the modern build's **JS baseline can outrun the pinned Electron's
V8**.

**Fix (interim):** the renderer's *value* imports now use the **legacy** build
(`pdfjs-dist/legacy/build/pdf.{mjs,worker.mjs}` — `usePdfDocument.ts`, `PdfReader.tsx`), which
self-polyfills the modern-API class via core-js (53 core-js refs vs 0 in the modern build) and exports
the **identical** surface (`getDocument`/`GlobalWorkerOptions`/`TextLayer`/`version`) — zero API rework.
This makes the renderer consistent with the main process, which already imported the legacy build.
Cost: ~+364 KB (main+worker), loaded on-demand when a PDF opens, not at boot. Type-only imports stay
on the package root. The CSP also gains `font-src 'self' data:` (independent real bug — pdf.js embeds
glyphs as `data:font/woff2`, which the original `font-src 'self'` blocked).

**Path back to modern:** bump Electron to ≥41 (Chromium 146 / V8 14.6, first with the API unflagged;
target latest stable) to realign the runtime, then revert the renderer to the modern build and drop the
+364 KB. Tracked in **issue #152** with its full blast radius (Chromium+Node ABI, breaking-change audit).

**Known coverage gap:** the committed smoke renders `tiny.pdf` (no embedded fonts), so the
`data:font/woff2` path and the heavier worker font-decode paths are not yet exercised end-to-end —
tracked separately for verification against a real multi-feature PDF.

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
- mozilla/pdf.js PR #20706 / commit 6323afab (2026-02-17, "unconditional `Map.prototype.getOrInsertComputed()`… polyfilled via core-js in the legacy builds") — the amendment's root-cause source
- `scripts/pdf-render-smoke.mjs` (the v0.6 smoke that caught the V8 gap); issue #152 (Electron bump to realign V8 + revert to modern)
