# Adding PDF Support to linsae: Library, Architecture & Slim-Slice Recommendations

## TL;DR
- **Use Mozilla pdf.js (`pdfjs-dist`, currently v6.0.227, published May 30 2026) rendered directly in the sandboxed renderer — NOT a third-party React wrapper, NOT a `<webview>`.** Build a thin in-house React component over `pdfjs-dist` so the text layer, viewport transforms, and worker config stay under your control. The slim slice (read + excerpt-drag, no annotation) **IS** achievable without the full dock shell, via a focused "right dock + wide content pane" pull-forward.
- **The doc's premise is mostly right, but its weakest assumption is the anchor.** A raw `{page, rect}` source_locator is fragile across re-render/reflow/zoom and re-import. The "car, not a faster horse" upgrade is a **hybrid anchor: store the quote text + a TextPosition-style offset + the rect as a visual fallback** (the W3C Web Annotation pattern used by Hypothesis and Obsidian PDF++). It fits inside your existing `source_locator` JSON column, costs nothing now, and prevents a painful migration later.
- **Single biggest risk: pdf.js is an XSS/RCE surface inside a privileged Electron renderer (the CVE-2024-4367 class of bug).** Mitigate by pinning a current pdf.js, setting `isEvalSupported:false`, and adding `worker-src blob:` to CSP. A genuinely better v2 candidate worth a spike — **EmbedPDF** (MIT, PDFium/WASM, headless, with a real selection API returning `{pageIndex, rect, textLines}`) — structurally sidesteps the pdf.js JS-eval font-parser bug class.

## Key Findings

1. **pdf.js is healthy and current.** `pdfjs-dist` v6.0.227 was published May 30 2026 (confirmed on npm/npmx, Apache-2.0). The project ships roughly monthly, has **20,938,608 weekly npm downloads** (official npmjs.com package page), 461 contributors, and zero license risk for a solo-dev OSS-adjacent app. It remains the default, lowest-risk choice.
2. **react-pdf (wojtekmaj) is MIT, v10.4.1**, but is a thin "display PDFs like images" wrapper that does not aim to be a full viewer and gives you less direct control over the text layer than excerpt-drag needs. The two commercial "React PDF viewer" products (`@react-pdf-viewer/core` by Nguyen Huu Phuoc, and react-pdf-viewer.dev's "React PDF") are **disqualified on licensing**.
3. **EmbedPDF is the standout newer entrant**: MIT, PDFium-via-WASM, headless React hooks, and — critically — a `@embedpdf/plugin-selection` whose `getFormattedSelection()` returns per-page `{pageIndex, rect, textLines}`, exactly the excerpt-drag payload. Latest release **v2.14.4, published June 8 2026** (GitHub Releases), **4.2k stars / 253 forks**, actively maintained.
4. **pdf.js exposes selection geometry via the DOM text layer + `getSelection().getRangeAt(0).getClientRects()`, converted to PDF space via `viewport.convertToPdfPoint()`** — there is no dedicated selection-rect API. PDF user space is origin-bottom-left; the viewport transform `[1,0,0,-1,0,height]` flips to canvas/CSS origin-top-left.
5. **A Chrome `<webview>` built-in PDF viewer cannot expose selected text + rect to your app** — it is a separate, locked-down browsing context. This would kill excerpt-drag, so it is disqualified as the primary reader.
6. **CVE-2024-4367** (arbitrary JS execution via a crafted font) was **patched in PDF.js v4.2.67, released April 29 2024** (Codean Labs, researcher Thomas Rinsma: "v4.2.67 … unaffected (fixed)"). The vulnerable path requires `isEvalSupported` to be true, "which is the default setting" (Wiz vulnerability database). Any current version is safe, but it defines the threat model.
7. **SQLite cannot alter a CHECK constraint in place** — the only supported path is the destructive 12-step table-recreation, which violates your additive-only migration discipline. A **separate `pdf_documents` table** is the cleaner answer.

## Details

### A. PDF rendering library

**Recommendation: pdf.js (`pdfjs-dist`) rendered in a thin in-house React component, in the sandboxed renderer process.** Reasons:
- Most battle-tested, Apache-2.0, actively maintained option; gives you direct access to the text layer and `viewport` transforms needed for excerpt-rect derivation.
- A thin wrapper you own (load doc → render page to canvas → render text layer → wire selection) is preferable to react-pdf, because excerpt-drag needs control over the text layer and pointer events that a "display PDFs like images" wrapper abstracts away. `pdfjs-dist` is a single dependency with no runtime deps of concern.

**Library comparison table** (verified June 2026):

| Library | License | Latest / date | React 19 | Electron 39 sandbox | React Compiler | Worker/CSP needs | Text-layer / selection API | Bundle | Maintenance |
|---|---|---|---|---|---|---|---|---|---|
| **pdf.js (`pdfjs-dist`)** | Apache-2.0 ✅ | 6.0.227 / May 30 2026 | N/A (not a React lib) | Yes, runs in sandbox | N/A | Needs `worker-src blob:` (worker is same-origin blob-wrapped) | DOM text layer + `getClientRects()` + `viewport.convertToPdfPoint()` | ~1–2 MB worker+core | Healthy, ~monthly, 20.9M wk dl |
| **react-pdf (wojtekmaj)** | MIT ✅ | 10.4.1 / early 2026 | Yes (React ≥16.8; tested w/ modern React) | Yes | Untested publicly | Same as pdf.js (wraps it); workerSrc config required | Renders text layer; selection via DOM, not a first-class rect API | wraps pdfjs-dist | Healthy, ~4M wk dl |
| **EmbedPDF** | MIT ✅ (engine/core/plugins); bundles PDFium | 2.14.4 / Jun 8 2026 | Yes (Next.js/SSR-ready; React 19 indicated) | Likely (WASM, no Node deps) — needs spike | Untested publicly | wasm CSP (`wasm-unsafe-eval`); loads `.wasm` | **Yes — `plugin-selection` `getFormattedSelection()` → `{pageIndex, rect, textLines}`** | PDFium WASM ~several MB | Active, 4.2k stars, young |
| **`<webview>` + Chrome PDF** | N/A | bundled w/ Electron | N/A | Separate context | N/A | Loosen `will-attach-webview` | **None — cannot extract selection** ❌ | 0 | N/A |
| **mupdf.js (Artifex)** | **AGPL-3.0 or commercial** ⚠️ | 1.3.6 / 2026 | N/A | WASM | N/A | WASM worker | `toStructuredText()` → JSON bbox+text (great for extraction) | WASM large | Healthy (Artifex) |
| **@react-pdf-viewer/core** | **Commercial** ⚠️ | — | — | — | — | — | — | — | — |
| **react-pdf-viewer.dev / "React PDF"** | **Commercial (watermark w/o key)** ⚠️ | — | — | — | — | — | — | — | — |
| Nutrient/PSPDFKit, Apryse, Foxit | **Commercial, enterprise $$** ⚠️ | — | — | — | — | — | full SDK | — | per Vendr's PSPDFKit buyer guide, "the average cost for PSPDFKit software is about $76,000 annually" |

Notes:
- **mupdf.js** is disqualified for the *shipping app* by AGPL-3.0 (copyleft — a solo OSS-adjacent desktop app would have to AGPL the whole app or buy a commercial license). It is excellent for **offline/build-time text+bbox extraction** via `toStructuredText("preserve-spans").asJSON()` if you ever want precomputed text geometry — flag for a later "precomputed anchor" feature, not the slim slice (and only out-of-process; see caveats).
- **EmbedPDF licensing caveat:** core/engine/plugins are MIT, but the bundled PDFium component is separately licensed; EmbedPDF's own README labels it **Apache-2.0**, while upstream PDFium is BSD-3-Clause. Either way it is permissive (no copyleft), so no license risk — but an ADR should note PDFium ships under its own permissive license, not MIT.
- Commercial SDKs (PSPDFKit/Nutrient ~$76k/yr average per Vendr; Apryse/Foxit similar enterprise pricing, quote-only) are disqualified on cost and licensing for a solo dev.

**"Faster-horse check" / cooler options:**
- **EmbedPDF is the most credible "car."** PDFium rendering is more accurate and faster than pdf.js, it's headless (you own all UI — fits your no-Tailwind, motion/zustand stack), and its selection plugin returns exactly the `{page, rect, text}` you need without hand-rolling `getClientRects()` math. Trade-offs: younger/less battle-tested than pdf.js, larger WASM binary, and you must verify Electron-sandbox WASM loading + CSP (`wasm-unsafe-eval`). **Ship the slim slice on pdf.js (known-quantity, lowest risk), but spike EmbedPDF in parallel as the likely v2 engine** — its selection API is materially better aligned with the excerpt-drag vision and it removes the JS-eval font-CVE class.
- **Precomputed/server-side text geometry** (mupdf.js `toStructuredText` at import time, stored alongside the PDF) is a real "car" for *anchor robustness* — resolving a quote to coordinates deterministically without depending on render-time DOM. Overkill for the slim slice; revisit if rect-drift becomes a problem.

### B. Excerpt-drag data flow

**Coordinate space.** pdf.js text items carry a `transform` matrix; the page `viewport` (from `page.getViewport({scale})`) maps PDF user space (origin bottom-left, points = 1/72") to canvas/CSS pixels (origin top-left), typically `[scale,0,0,-scale,0,height]`. To capture a selection rect in **stable PDF user-space units** (scale-independent — the correct thing to persist), take `window.getSelection().getRangeAt(0).getClientRects()`, subtract the page container's `getBoundingClientRect()`, then apply `viewport.convertToPdfPoint(x, y)` to each corner. Persist PDF-space rects, not CSS pixels, so the locator survives zoom changes. This is the canonical pdf.js approach.

**Anchor robustness — the key design call.** Prior art strongly favors *not* relying on a raw rect alone:
- **Obsidian PDF++** stores links as `#page=N&selection=a,b,c,d` (text-index based) plus an optional `&rect=x1,y1,x2,y2`. Its author explicitly notes that if the feature breaks, `&rect=` links still navigate to the correct **page** but lose the exact in-page location — i.e., rect is the weak fallback, text-selection indices are primary.
- **Zotero** stores `{pageIndex, rects:[[x1,y1,x2,y2]]}` in PDF coordinates in its DB (not in the file) and is actively building structural page analysis (header/footer exclusion, inter-page selections) — showing raw rects need structural help.
- **Hypothesis / W3C Web Annotation Data Model** is the mature pattern: combine **TextQuoteSelector** (exact quote + prefix/suffix, survives reflow), **TextPositionSelector** (character offsets, survives ambiguity), and a fallback. Hypothesis's "fuzzy anchoring" explicitly notes PDF needs quote *normalization* because different viewers emit different inter-word spacing.

**Recommendation for `source_locator`:** keep your committed shape but enrich it (all fields fit the existing JSON column — **no schema change**, honoring your "no note-schema migration" constraint):
```
{"media":"pdf","pdf_id":"…","page":42,
 "rect":[x,y,w,h],                  // PDF user-space, visual fallback / highlight box
 "quote":"the exact selected text", // TextQuoteSelector — primary re-anchor
 "prefix":"…","suffix":"…",          // disambiguation for repeated text
 "textStart":1234,"textEnd":1290}    // TextPositionSelector over page text
```
At render time, re-anchor by quote first, fall back to position, then to raw rect. This is the "car": robust source back-links that survive re-render, zoom, and even re-import of a slightly different PDF build of the same document.

**Drag mechanics.** Your canvas already uses pointer events (not HTML5 DnD), and HTML5 drag-and-drop across a pane boundary with a live text selection is notoriously fiddly (the selection is consumed by `dragstart`; drop targets need explicit handling). **Recommend the "capture → place" model MarginNote itself uses:** user selects → a contextual excerpt affordance appears (MarginNote shows an excerpt menu on selection) → user clicks "excerpt"/grabs a drag-handle → you package the payload (text + hybrid locator + optional region image) into a pending-note in zustand → user clicks/drops onto the canvas to place it. This decouples pdf.js's native selection from your pointer-based canvas, avoids fighting the browser's selection/drag interaction, and matches the proven MarginNote UX. A pointer-drag from a dedicated drag-handle (not from the raw text) into the canvas is equally viable and can reuse your existing canvas pointer code.

### C. PDF annotation (full milestone)

- **Reuse the in-house `ink/` module over a per-page SVG overlay.** perfect-freehand is coordinate-space agnostic (points in, outline out); the maintainer's guidance is to *not* fight `viewBox`/coordinate mismatches but to transform a `<g>` element. For a PDF page, set the ink layer's SVG `viewBox` to the **PDF page dimensions / user-space units** (e.g., `0 0 595 842`), exactly as your constraint requires — distinct from the screenshot Scene's image-pixel envelope.
- **Multi-page coordinate mismatch:** each PDF page is its own coordinate space. The clean model is **one ink Scene per (pdf_id, page)** — a sibling `PdfScene` keyed by page, each with its own page-dimension viewBox. The screenshot `Scene{width,height}` image-pixel envelope is the wrong parent type (your constraint already forbids reusing it).
- **Type-design question:** parameterize the ink geometry over its coordinate frame rather than overloading `Scene`. A `PdfScene` (or `Scene` generic over a `Frame` = `{units:'pdf-user'|'image-px', viewBox}`) keeps perfect-freehand's points-are-truth invariant while letting serialization/parse round-trip per page. Prior art: ngx-extended-pdf-viewer and the `pdfAnnotate` library both overlay a canvas/SVG editor layer on a pdf.js page and map pointer coords to PDF coordinates per page (subtracting page offset, dividing by scale) — confirming the per-page-frame approach.
- **pdf.js native editor layer** (FreeText, Ink, Highlight, Stamp, Signature editors now exist) is an alternative, but it stores into the PDF/its own model and would not reuse your `ink/` module or round-trip to your SVG sidecar. Document it, but the vision's preference (reuse `ink/`, SVG serialize/parse) points to the custom overlay.

### D. Storage + schema

- **PDF base file storage:** keep your content-addressed `<yyyy>/<mm>/<sha256>.pdf` pattern. Even though PDFs are rarely byte-identical across imports (so dedup rarely fires), the pattern gives idempotent re-import and a stable on-disk identity. A dedicated `pdfs/` dir is unnecessary; reuse the existing attachment storage convention.
- **CHECK constraint:** SQLite **cannot** add a value to `CHECK (kind IN ('screenshot','clip'))` in place. The supported route is the 12-step table-recreation (create new table, copy, drop, rename, rebuild indexes/triggers) — destructive and contrary to your additive-only + soft-delete discipline. The `PRAGMA writable_schema=ON` edit of `sqlite_master` is explicitly cautioned against (corrupts the DB on any typo). **Recommendation: do NOT touch the attachments CHECK. Add a separate additive `pdf_documents` table** (and later `pdf_annotations`), mirroring the attachment shape but with PDF-specific columns. Purely additive, soft-delete-compatible, never rewrites `attachments`.
- **Metadata:** a `pdf_documents` table (id, sha256, title, page_count, imported_at/fetched_at, soft-delete column) mirroring your `video_sources` table is the right call — store metadata in columns, not JSON, so you can query by title/page count. The per-note `source_locator` JSON stays as the pointer.
- **Annotation sidecar format:** screenshots use a single `<attachmentId>.svg`. PDFs are multi-page, so **one sidecar per (document, page)** — e.g., `<pdf_id>/<page>.svg` — is cleaner than one giant document sidecar with internal page indexing, because it keeps each SVG's `viewBox` tied to that page's dimensions and avoids rewriting a huge file on every stroke. This mirrors how **Zotero and MarginNote keep annotations in a database/sidecar keyed by pageIndex rather than baked into the PDF** (Zotero stores `{pageIndex, rects}` per annotation row in its DB; MarginNote keeps excerpts/handwriting as cards bound to document positions), preserving a clean original file. Alternatively store annotation geometry as rows in `pdf_annotations(pdf_id, page, scene_json/svg, …)` and skip filesystem sidecars — more consistent with your SQLite-first design. **Choose rows-in-DB if annotations are small, sidecar files if they get large.**

### E. Slim-slice viability — VERDICT: YES

The slim slice (read + excerpt-drag, no annotation) is achievable **without** building the full tabbed dock shell. It does require *some* dock work, because the current embryo is left-dock-only, one-pane, in-memory width, resize-clamped [220,400]px — too narrow and wrong-sided for a PDF reading pane.

**Of the three integration options:**
1. *Third viewMode `'pdf'` (full-window, mod+3):* **Wrong.** A content pane must coexist with the canvas for excerpt-drag; a peer full-window view defeats the core MarginNote move (you can't drag from PDF to canvas if they don't share the screen). Reject.
2. *Dock pane (`paneId='pdf'`) coexisting with canvas, in a right dock:* **Correct target**, but needs the embryo extended to a right home dock with a wider clamp.
3. *Thread-replacement hack via `pdfNoteId` (like ThreadView replacing feed+composer):* a throwaway that does **not** let the PDF coexist beside the canvas (ThreadView *replaces* feed+composer) — so it also fails the coexistence requirement and would be torn out.

**Recommendation: pull forward a minimal "right dock + wide content pane" slice** — the narrowest cut of option 2. Concretely: add a right-side home dock that hosts a single wide content pane (the PDF reader) alongside the canvas; skip tabs, skip multi-pane, skip left-dock changes, give the right pane its own wider width clamp. This is the minimum that (a) puts PDF and canvas on screen together so excerpt-drag works, and (b) is forward-compatible with the eventual full dock shell (the right dock becomes one home for the tabbed pane system later).

**Does the slim slice honor "dock-shell design must protect the excerpt-drag path from day one"?** Yes — because you build the *coexistence* (PDF pane beside canvas) and the *capture→place* data flow from the start, which are exactly the invariants the excerpt-drag path needs. It forecloses nothing: the hybrid anchor lives in `source_locator` (no migration), the right-dock pane generalizes to the full shell, and annotation (per-page SVG over pdf.js) layers on later without revisiting the reader. The one thing to **avoid** is the thread-replacement hack — it would bake in a replace-not-coexist assumption you'd have to remove.

### F. Security assessment

**Renderer vs webview — recommend pdf.js in the sandboxed renderer.** The YouTube `<webview>` precedent exists only because the YouTube IFrame player needs a real HTTP origin; a local PDF has a different threat model and gains nothing from a webview while losing all selection access. Keep the `will-attach-webview` allowlist locked to YouTube; do **not** loosen it for PDFs.

**CSP changes required for pdf.js:**
- pdf.js spins up a Web Worker. Per mozilla/pdf.js issue #9676, pdf.js routes `workerSrc` through a blob wrapper for same-origin compliance, so in practice you must allow **`worker-src blob:`** in your single `<meta>` CSP. (Safari/older fallbacks use `child-src`, irrelevant in Electron/Chromium.) You should **not** need `frame-src`/`child-src` for iframes if you render to canvas + text layer yourself. No `script-src` relaxation is required when the worker is blob-based — keep `script-src 'self'` with no `unsafe-eval`.
- Serving the PDF: add a `.pdf → application/pdf` entry to the loopback shell's `/_media/` MIME map (currently falls back to `application/octet-stream`). Keep `X-Content-Type-Options: nosniff`. You may also send `Content-Disposition: inline` — but since pdf.js fetches the bytes via `fetch`/XHR and renders them itself (not a browser navigation), Content-Disposition is largely moot; correct MIME + nosniff is the important part. Serving `application/pdf` over your GET-only, path-traversal-guarded, 127.0.0.1-bound loopback is safe.

**Sandbox hardening for malicious PDFs:**
- Treat local PDFs as **untrusted input** (users import arbitrary files); a malicious PDF is the realistic threat. CVE-2024-4367 (patched in v4.2.67, April 29 2024) showed a crafted font could achieve arbitrary JS execution in the pdf.js context — and per Codean Labs' disclosure, the bug "allows an attacker to execute arbitrary JavaScript code as soon as a malicious PDF file is opened" and "seriously impacts many web- and Electron-based applications"; on Electron apps that don't sandbox JS this escalates to native code execution.
- Mitigations: (1) pin a **current** pdf.js (6.x) and keep it updated; (2) ~~set **`isEvalSupported: false`**~~ _**v6 no-op** — `isEvalSupported` was removed in pdf.js PR #21245 (v5→v6); the eval-based font path was pruned with the option, so the mitigation is structural in v6, not opt-out. See ADR 0043 §"Security mitigations" + spec §2 for the shipped engine config._; (3) you already have `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` — the critical backstop preventing XSS-in-renderer from becoming RCE; (4) keep the strict CSP (no `unsafe-eval` in `script-src`); (5) consider font hardening only if issues arise. Your baseline is already strong; the main action items are **`worker-src blob:` + the MIME entry** (~~`isEvalSupported:false`~~ is not a v6 option — see ADR 0043 §"Security mitigations").
- **EmbedPDF/PDFium note:** a WASM/PDFium engine parses fonts/JS in C++-compiled-to-WASM, memory-sandboxed by the WASM runtime, and does **not** use JS `eval` for font glyphs — so it structurally avoids the CVE-2024-4367 *class*. This is a real security argument for it as a v2 engine (offset by WASM's own, different memory-safety considerations and a less-audited codebase than pdf.js).

## Recommendations

**Stage 0 — ADR + decisions (now):**
- Write one ADR adding `pdfjs-dist` (Apache-2.0, single dep) as the slim-slice render engine. Record the EmbedPDF spike as a tracked v2 alternative.
- Lock the `source_locator` hybrid-anchor shape (quote + prefix/suffix + textStart/textEnd + rect) before writing any capture code — it costs nothing now and is expensive to retrofit. **Benchmark that would change this:** if you confirm PDFs reliably re-render identical rects across your supported zoom/DPI range *and* you never re-import, you could drop the quote/position fields — but the W3C/Hypothesis/PDF++ evidence says don't.

**Stage 1 — Slim slice (priority):**
1. Add `worker-src blob:` to CSP; add `.pdf → application/pdf` to the loopback MIME map (keep nosniff).
2. Build the minimal **right dock + one wide content pane** (option 2, narrowest cut). Skip tabs, multi-pane, and left-dock changes.
3. Build a thin pdf.js renderer component: load → canvas + text layer → wire `getSelection().getClientRects()` → `viewport.convertToPdfPoint()` → build the hybrid `source_locator`.
4. Implement **capture→place** (MarginNote-style): selection → excerpt affordance → pending note in zustand → click/drop onto canvas → persist note with `source_kind='pdf'`.
5. ~~Set `isEvalSupported:false`.~~ _v6 no-op — `isEvalSupported` was removed in pdf.js PR #21245; see ADR 0043 §"Security mitigations" + spec §2 for the shipped engine config._
6. Add the `pdf_documents` table (additive) for title/page_count/sha256/imported_at; store the file content-addressed.

**Stage 2 — Full milestone (annotation, secondary):**
1. Add `pdf_annotations` (rows-in-DB) or per-page `<pdf_id>/<page>.svg` sidecars.
2. Introduce a `PdfScene` sibling type (or `Scene` parameterized over coordinate frame) with `viewBox` = PDF page user-space dims; reuse perfect-freehand `ink/`.
3. Render a per-page SVG overlay above the pdf.js page canvas; map pointer coords per page.

**Stage 3 — Evaluate the "car":**
- Run the EmbedPDF spike (selection plugin, Electron-sandbox WASM load, CSP). **Threshold to switch:** if EmbedPDF loads cleanly under `sandbox:true`/strict CSP, its `getFormattedSelection()` gives stable `{pageIndex, rect, textLines}`, and WASM size is acceptable, adopt it as the v2 engine — its selection API and PDFium accuracy materially beat hand-rolled pdf.js text-layer math, and it removes the JS-eval font-CVE class.

## Caveats / Open Questions (UNKNOWNS for the team)
- **EmbedPDF + Electron 39 sandbox is unverified.** No public source confirms its PDFium WASM loads under `sandbox:true`/strict CSP with `wasm-unsafe-eval`. Needs a hands-on spike before committing. Its exact React 19 `peerDependencies` string could not be directly read (npm blocked the raw fetch); React 19 support is strongly *indicated* (Next.js/SSR-ready, June 2026 releases) but not quoted.
- **React Compiler 1.0 compatibility** of react-pdf and EmbedPDF is not publicly documented — verify in your own build. (pdf.js itself is framework-agnostic, so a thin in-house component you control is the safest re React Compiler.)
- **react-pdf v10's exact React 19 strict-mode behavior** (double-effect mounting of the text layer) is not fully documented for this use case; historical strict-mode text-layer bugs existed, and react-pdf had text-layer selection-overlay bugs as recently as the v9→v10 line. One more reason to prefer your own thin pdf.js component over a wrapper.
- **Rect drift across pdf.js major versions / different PDF builds of "the same" document** is real (different viewers emit different inter-word spacing — Hypothesis documents this). The hybrid anchor mitigates but cannot fully guarantee re-anchoring across genuinely different PDF builds; flag for QA.
- **DB rows vs SVG sidecars for annotations** depends on expected ink volume per page, a product/UX unknown — pick after you observe real stroke sizes.
- **mupdf.js AGPL** is a hard blocker for bundling, but its build-time text extraction could power a future precomputed-anchor feature *if run as a separate out-of-process tool/CLI* — the AGPL boundary for an out-of-process tool vs an in-app library needs legal clarity before relying on it.