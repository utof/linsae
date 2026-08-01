# 0059 — Read-back anchors on `rect`; text selectors are advisory

Status: accepted (v0.8)

## Context

v0.6 shipped the forward direction of excerpt-drag: select text in a PDF, drop it on the
canvas as a note carrying a `source_locator`.
[#155](https://github.com/utof/linsae/issues/155) asks for the return trip — click an
excerpt note, reopen the reader **at the place it came from**.

The stored locator is deliberately hybrid (`PdfLocatorSchema`): `page`, `rect`, `quote`,
`prefix`, `suffix`, and optional `textStart`/`textEnd`. So read-back has to choose which of
those is the **anchor** and which are corroboration.

**#155 states a preference: use `textStart`/`textEnd` + `quote`/`prefix`/`suffix` "for
resilience across pdf.js render drift", falling back to `rect`.** That is the reasonable
prior — text is what the user selected, pixels are an artifact of how it was drawn. This ADR
records the deliberate reversal of it, and why the reversal is *not* the categorical claim
"there is no drift."

## Decision

**`rect` is the primary anchor. Text selectors are advisory. A degenerate rect scrolls to
the page and skips the flash.**

### Why `rect` is more stable here than the text offsets — the specific reasoning

`rect` is **not** stored in pixels. `clientRectsToPdfRect` runs each client rect through
`viewport.convertToPdfPoint`, which applies the inverse of the viewport transform
(`clientRectsToPdfRect.ts:22-23`), so what is persisted is **PDF user space** — invariant
under zoom, dpr, dock width and device. Three further facts make the round-trip closed, each
verified in `pdfjs-dist@6.0.227`:

1. **Rotation matches on both sides by default.** `getViewport({scale})` defaults `rotation`
   to `this.rotate`, the page's own `/Rotate` (`build/pdf.mjs:15436-15441`). Capture
   (`PdfPage` builds the viewport at the render scale) and read-back (`PdfReader` builds one
   at scale 1) both take the default, so both transforms carry the same rotation.
2. **The origin matches.** `getViewport` passes `viewBox: this.view` (`:15443`), i.e. the
   page's cropBox, on both sides — so `convertToPdfPoint` inverse-maps into absolute
   cropBox-origin user space, not into anything viewport-relative.
3. **`userUnit` cancels.** `PageViewport` folds it into the transform with
   `scale *= userUnit` (`pdf.mjs:810`, transform composed at `:863`), and the inverse
   divides it back out (`convertToPdfPoint` → `Util.applyInverseTransform`, `:905-909`).
   Same value both directions, same page, so it is not a source of drift.

Text offsets, by contrast, depend on `getTextContent()` **item ordering and splitting**,
which is a rendering-pipeline detail that genuinely does vary across pdf.js versions.

### What this ADR does NOT claim

**It does not claim "there is no drift to be resilient against."** That version of the
argument is too strong, and the counterexample is in our own code path, not a hypothetical:
`clientRectsToPdfRect` returns `[0, 0, 0, 0]` when the filtered rect list is empty
(`clientRectsToPdfRect.ts:16`), and capture writes whatever it returns, unconditionally
(`useExcerptCapture.ts:117-137`). A degenerate rect is therefore reachable and persisted.
Hence:

- `rect` anchors the jump **when non-degenerate**; a zero-area rect scrolls to the page and
  **skips the flash** rather than flashing a meaningless box (the `if (target.rect)` branch
  of the restore/jump-drain effect, `PdfReader.tsx`).
- `quote` is carried for the flash label and for a future different-edition re-anchor.
- **Full text-based re-anchoring is deferred**, not rejected. It matters when the underlying
  file has been *replaced* by a different edition — a real case, just not this milestone's.
  The trigger to revisit is a re-paginated or re-exported source file, which is also what
  [#189](https://github.com/utof/linsae/issues/189) has to be fixed for first.

### Degenerate detection branches on zero WIDTH/HEIGHT, not on "the box is zero"

Non-obvious and easy to "simplify" wrongly. `pdfRectToCssBox` maps a `[0,0,0,0]` rect
through the viewport's y-flip, so the resulting box still has a **non-zero `top`** — the
page height — and a non-zero `left` from the viewport offset. Testing the whole box for zero
would therefore never fire, and the fraction derived from that `top` would park the reader
at the page's **bottom** edge. The condition is
`box.width > 0 && box.height > 0 && vp.height > 0` (`PdfReader.tsx`), pinned by
`PdfReader.test.tsx`'s *"a DEGENERATE [0,0,0,0] rect scrolls to the page WITHOUT flashing"*.

### The flash CANNOT go through the page registry

The obvious implementation — get the target page's viewport from the page registry ADR
0058's capture path already uses — is structurally impossible, and this is the single most
likely thing for a future reader to "fix" back:

- `PdfPage` registers itself **only after its text layer resolves** (`PdfPage.tsx:156-158`),
  which is necessarily **after** the scroll that windows the page. The page the flash
  targets is by definition not mounted at the moment the jump is armed, so the registry
  entry is `null` exactly when it is needed.
- The registry is a **ref**, so its later write triggers no re-render — there is no retry to
  hang the flash on.

Instead the reader gets the viewport from `doc.getPage(page)` directly, inside the
restore/jump-drain effect (`PdfReader.tsx`). pdf.js memoizes page proxies, and `getPage`
resolves whether or not the page is mounted. The box is computed against the **scale-1**
viewport and multiplied by the live scale at render time (`flashCssBox`, `PdfReader.tsx`;
the `flashCss` const is re-derived every render). That is exact — a viewport at scale `s` is
the scale-1 viewport times `s` (`computePdfRender.ts:82-85`) — and it has a second payoff:
**the flash survives a zoom step taken while it is up**, with no re-derivation.

The overlay is rendered as a **sibling** of `PdfPage` inside the same positioned item
wrapper, and reproduces `PdfPage`'s two nested divs so `margin: 0 auto` does the horizontal
centring identically rather than being re-derived (and getting the `zoom > 1` overflow case
wrong) — the `data-testid="pdf-readback-flash"` markup in `PdfReader.tsx`.

### Precedence: a pending jump beats the persisted restore, as a VALUE choice

A read-back jump and the §6 persisted-position restore are both candidates for the one
scroll an open gets. They are resolved by reading both and **picking one**
(`const target = jump ?? restoreTargetRef.current`, `PdfReader.tsx`), not by two code paths
that must be kept from both running. The jump is carried on a consumed-once zustand store
(`pendingJumpState.ts`) because `NoteBubble` renders under both the feed and the generic
thread child list, and the thread call-site passes no reader prop — a prop-driven affordance
would be silently dead in threads, which is exactly where excerpt notes are read
(`useOpenPdfAt.ts:7-29`).

## Alternatives

- **#155's original: text selectors primary, `rect` as fallback.** Rejected on the three
  verified facts above — `rect` is version-invariant user-space geometry, while
  `getTextContent()` ordering is the thing that actually moves between pdf.js releases. It
  is also, today, unimplementable as the primary:
  [#189](https://github.com/utof/linsae/issues/189) means `textStart`/`textEnd` are absent
  for most real excerpts. Revisit when #189 is fixed **and** a different-edition case
  appears.
- **Try text first, fall back to `rect` on miss.** Rejected for this milestone: it doubles
  the read-back paths and their tests to buy resilience against a failure mode we have no
  instance of, while the degenerate-rect case (which we *do* have an instance of) is handled
  by one condition.
- **Flash from the page registry once the page mounts** (arm a retry on registration).
  Rejected: the registry is a ref with no re-render, so it would need a subscription or a
  polling effect, and `doc.getPage()` supplies the same viewport with neither.
- **Store the flash box at the rendered scale.** Rejected: it would need re-deriving on
  every zoom step while the flash is up. Scale-1 plus a multiply at render time is both
  simpler and exact.

## Consequences

- **A read-back jump is only as good as the captured rect.** Anything that degrades capture
  geometry degrades read-back silently — which is why the zero-area `<br>`-rect filter (ADR
  0058) and the degenerate-rect skip are both defended by tests rather than comments.
- **`rect` is now load-bearing persisted data.** A future change to `clientRectsToPdfRect`,
  `pdfRectToCssBox`, or the viewport either side of them is a data-compatibility change for
  every excerpt ever captured, not a rendering tweak.
- **The y-flip is asserted end-to-end in real Electron.** The `read-back-jump-and-flash`
  gate (`scripts/pdf-multipage-smoke.mjs:601-690`) captures a real selection on the last
  page, reopens via the note affordance, and asserts the flash's
  `left`/`top`/`width`/`height` each land within `FLASH_POSITION_TOLERANCE_CSS_PX` (3 CSS
  px) of the captured rect projected onto the page — with `top` computed as
  `(pageHeight − (y + h)) × scale`. Asserting `y` instead would pass a flash one rect-height
  too low, so
  this gate is what independently confirms the flip. Recorded slack is well under 1 px
  (`scripts/pdf-multipage-smoke.mjs:174-180`); happy-dom cannot check any of it.
- **Canvas `NoteCard` has no read-back affordance yet.** `canvas/NoteCard.tsx` has no
  `source_locator` knowledge; since excerpts are *placed on the canvas*, that is the natural
  second entry point and is deliberately deferred to a follow-up issue — the reader-side
  handoff should prove itself on one surface first (spec §5.1).
- **A locator with no `page` degrades to page 1 with no flash** rather than being rejected
  (`targetFromLocator`, `PdfReader.tsx`) — that is the document-level source note's own
  locator (ADR 0050), which is a legitimate value, not a corrupt one.

## Sources

- [#155](https://github.com/utof/linsae/issues/155) — the issue whose stated selector
  preference this ADR reverses.
- `pdfjs-dist@6.0.227/build/pdf.mjs:15436-15441` — `getViewport` defaulting
  `rotation = this.rotate`; `:15443` — `viewBox: this.view`; `:810` — `scale *= userUnit`;
  `:863` — the composed transform; `:893-897` / `:905-909` — `convertToViewportPoint` /
  `convertToPdfPoint`.
- `src/renderer/src/pdf/clientRectsToPdfRect.ts:16` (the `[0,0,0,0]` empty-input return),
  `:22-23` (`convertToPdfPoint` divides the viewport scale out at capture).
- `src/renderer/src/pdf/pdfRectToCssBox.ts` — the y-up→y-down mapping
  (`convertToViewportPoint(x, y + h)` is the CSS **top**-left).
- `src/renderer/src/pdf/PdfReader.tsx`, by symbol (this file is edited every PDF batch, so
  line numbers go stale faster than the claims): the `FlashOverlay` interface + TSDoc (why
  it does not use the registry), `flashCssBox`, `targetFromLocator`, the restore/jump-drain
  effect (the `jump ?? restoreTargetRef.current` value choice, the scale-1 `getViewport`
  read, and the degenerate-rect condition), the `flashCss` per-render re-derive, and the
  `data-testid="pdf-readback-flash"` overlay markup.
- `src/renderer/src/pdf/useOpenPdfAt.ts`, `src/renderer/src/pdf/pendingJumpState.ts` — the
  consumed-once store the jump travels on, and why it is store-driven rather than
  prop-driven.
- `src/renderer/src/pdf/PdfReader.test.tsx` — the
  `describe('PdfReader read-back drain (spec §5.2–§5.4)')` suite, including *"A PENDING JUMP
  BEATS THE PERSISTED RESTORE"*, *"scrolls to the rect VISUAL TOP within the page, not its
  PDF-space y"*, *"a DEGENERATE [0,0,0,0] rect scrolls to the page WITHOUT flashing"*, and
  *"persists where the jump landed (the writer follows the read-back)"*.
- `scripts/pdf-multipage-smoke.mjs:174-180` (tolerance + recorded slack), `:601-690` (the
  `read-back-jump-and-flash` gate).
- `docs/specs/v0.8-multipage-pdf.md` §5.1–§5.4.
- `adrs/0058-pdf-cross-page-selection-start-anchor.md` — the capture side of the same
  round-trip, and why its dropped text selectors are affordable;
  `adrs/0050-pdf-document-is-a-source-note.md` — where excerpt notes live.
