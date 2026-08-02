# 0058 — Cross-page PDF selections anchor to the START page (tree order, not drag direction)

Status: accepted (v0.8)

## Context

Excerpt-drag is why PDF exists in this app. Through v0.6 the capture path could assume **one
page, one viewport, one origin element** — there was only page 1. Continuous scroll (ADR
0056) breaks all three assumptions at once, and it introduces a case that could not exist
before: a drag that starts on one page and ends on the next.

`useExcerptCapture` must answer three questions for such a selection: which page does the
locator name, which rect does it store, and what happens to the text selectors. Getting the
first one wrong is not a cosmetic bug — the locator is persisted in `source_locator` and
drives read-back (ADR 0059) for the life of the note.

There is also a subtler trap. The obvious way to ask "where did this selection start" is
`Selection.anchorNode` — and `anchorNode` **is** drag direction: on an upward drag it is the
visually *lower* end. Using it would silently record the wrong page for exactly the
selections that motivated the question.

## Decision

**A cross-page selection anchors to the page containing `range.startContainer`** — the
**start page in tree order**, which is the visually *upper* page regardless of which
direction the user dragged.

Per the DOM standard, a Range's start is always before-or-equal its end in **tree order**
(https://dom.spec.whatwg.org/#concept-range), and the virtualizer emits page items in
ascending index, so tree order and visual order agree here. Direction is exposed only
through `Selection.anchorNode`/`focusNode`, which this code never reads
(`src/renderer/src/pdf/useExcerptCapture.ts:57-65`).

The resulting locator, unchanged in shape from v0.6:

| field | value for a cross-page selection |
| --- | --- |
| `page` | the **start** page |
| `rect` | the **start page's portion only** — the client-rect filter drops everything else |
| `quote` | the **full** selected text, both pages |
| `prefix` / `suffix` / `textStart` / `textEnd` | **omitted** |

**Rect filtering is what keeps the rect honest.** Rects are kept only when their vertical
centre lies inside the anchor page's content box (`useExcerptCapture.ts:76-93`). Without it
a cross-page drag unions boxes across the inter-page gap and yields a rect taller than the
page itself. This is sound under partial scroll because both `getClientRects()` and
`getBoundingClientRect()` return unclipped viewport-space boxes — ancestor overflow does not
clip them.

**The dropped text selectors are honest degradation, not an oversight.** The
prefix/suffix/offsets come from the anchor page's own `getTextContent()`, and a cross-page
quote cannot occur in the anchor page's text — so the lookup finds nothing and the guards
omit all four fields (`useExcerptCapture.ts:110-136`). No new branch was added. ADR 0059
explains why losing them costs almost nothing: `rect` is the primary anchor and the text
selectors are advisory.

> v0.8 spelled that lookup `fullText.indexOf(text)` returning `-1`, guarded by `idx >= 0`.
> v0.8.2 replaced it with `locateQuoteInPageText` returning `null` (#189 — see Consequences).
> The decision above is unaffected; what changed is only which selections reach the
> no-match branch. The old spelling is recorded here because the paragraph originally cited
> it, and a reader chasing `indexOf` in the current file will not find it.

**"Cross-page" means ADJACENT WINDOWED pages only.** This is a scope statement, not a
limitation discovered later. Pages unmount once they pass overscan (`overscan` is `1` at fit
and `0` when zoomed — ADR 0056), and unmounting a page destroys its text layer, which
destroys the selection's end container mid-drag. So a selection may span page N and N+1
while both are resident; it cannot span page N and N+40. The reader does not claim general
cross-page selection support and should not be described as having it.

`SourceLocatorSchema` / `PdfLocatorSchema` are **unchanged** — no migration, no schema
churn, and every v0.6/v0.6.4 locator stays valid.

## Alternatives

- **Anchor to `Selection.anchorNode`'s page.** Rejected: `anchorNode` is where the *drag*
  began, so an upward drag would record the lower page. This is the "fix" a future reader is
  most likely to attempt, which is why it is written down rather than merely avoided.
- **Anchor to the page with the most selected text** (or the largest rect area). Rejected:
  it is not stable — nudging the selection by one line can flip which page wins, so the same
  visual selection yields different locators on different attempts. Tree order is
  deterministic.
- **Store a multi-page locator** (`pages: [{page, rect}, …]`). Rejected for this milestone:
  it is a `PdfLocatorSchema` change and therefore a migration plus a read-back rendering
  change, for a case the spec's own scope limits to two adjacent windowed pages. Revisit if
  dogfooding shows multi-page excerpts are common — the trigger is real usage, not
  aesthetics.
- **Reject cross-page selections outright** (bail, no excerpt). Rejected: the user made a
  deliberate selection and the full text is available in `quote`; refusing to capture it
  loses more than the partial rect does.

## Consequences

- **A cross-page excerpt reads back to the top of its start page's rect**, i.e. to the
  beginning of what was selected — which is the useful end of it. The tail on page N+1 is in
  `quote` but has no geometry.
- **FIXED in v0.8.2 — was: the text selectors are dropped for every MULTI-LINE selection,
  not just cross-page ones** ([#189](https://github.com/utof/linsae/issues/189)).
  `sel.toString()` joins visual lines with `\n` while `getTextContent()` items are joined
  with a space, so `fullText.indexOf(text)` returned `-1` for any selection spanning a line
  break and the `idx >= 0` guards omitted prefix/suffix/textStart/textEnd. This ADR shipped
  describing that as accepted degradation; it was a bug, and saying so here is what let it
  sit for two milestones. v0.8.2 replaced the `indexOf` with
  `src/renderer/src/pdf/locateQuoteInPageText.ts` — a whitespace-insensitive match that
  reports **raw** offsets into the page text, so already-persisted locators keep their
  basis. A multi-line selection now carries all four fields
  (`useExcerptCapture.test.ts:533-565`), and the real-Electron `excerpt-text-selectors`
  gate pins it in the product, where the bug was found and where happy-dom cannot look.

  **What this does NOT change: the cross-page case above is still honest degradation.** A
  quote whose tail lives on page N+1 genuinely is not in the anchor page's text, so the
  helper returns `null` and the same four fields are still omitted — under no normalization
  can that quote match (`useExcerptCapture.test.ts:306-335`). Do not read this fix as
  making cross-page text selectors recoverable; that would need the multi-page locator this
  ADR rejected above.
- **Anything that changes `overscan` changes what "adjacent" means.** Raising overscan
  widens the window in which a cross-page selection can be made; dropping it to 0 at zoom >
  1 means a zoomed-in cross-page drag usually cannot be made at all.
- **Zero-area client rects are filtered before the page test, and that ordering matters.**
  pdf.js v6's `TextLayer` emits `<br role="presentation">` between line spans whose boxes
  are width 0, height ~21, at x = 0 — with the topmost one sitting slightly *above* the
  page. The page test alone does not catch it (a box at top −3 with height 21 has centre
  +7.5 and passes), so a multi-line selection would report a rect starting at the page's
  left edge and overflowing its top (`useExcerptCapture.ts:77-92`). happy-dom renders no
  text layer, so this is caught only by the real-Electron `excerpt-rect-geometry` gate.

## Sources

- https://dom.spec.whatwg.org/#concept-range — a Range's start is before-or-equal its end in
  tree order; direction lives on `Selection.anchorNode`/`focusNode`, not on the Range.
- `src/renderer/src/pdf/useExcerptCapture.ts:54-66` — element-safe walk-up from
  `range.startContainer` to `[data-page-number]` (a legal Range boundary point is
  `(element, childIndex)`, so `startContainer` can itself be an Element and a bare
  `.parentElement?.closest(…)` climbs past the page wrapper); `:77-94` — the zero-area +
  anchor-page client-rect filter; `:110-136` — the `locateQuoteInPageText` lookup and the
  guards that omit the four text fields when it returns `null`.
- `src/renderer/src/pdf/locateQuoteInPageText.ts` — the v0.8.2 lookup (#189): matches
  whitespace-insensitively, reports RAW offsets so persisted locators keep their basis.
- `src/renderer/src/pdf/clientRectsToPdfRect.ts` — unchanged from v0.6; unions whatever
  rects it is given, which is why the filter above must run first.
- `src/renderer/src/pdf/useExcerptCapture.test.ts:218-250` (page-1 no-regression:
  byte-identical v0.6 locator), `:306-335` (cross-page selection anchors to the START page,
  and still drops the four text fields after the #189 fix), `:337-365` (rect not smeared
  across the gap), `:367-404` (zero-area `<br>` rects dropped), `:286-304` (Element
  `startContainer`), `:533-565` (#189: a multi-line selection KEEPS the four fields).
- `scripts/pdf-multipage-smoke.mjs` — the `excerpt-page-resolution`,
  `excerpt-rect-geometry` and `excerpt-text-selectors` gates (real Electron; happy-dom
  renders no text layer).
- `docs/specs/v0.8-multipage-pdf.md` §4.7.
- `adrs/0056-pdf-continuous-scroll-virtualization.md` — the windowing (and `overscan`) that
  bounds "adjacent"; `adrs/0059-pdf-read-back-rect-primary.md` — why the dropped text
  selectors are cheap; `adrs/0050-pdf-document-is-a-source-note.md` — where the captured
  locator lands.
