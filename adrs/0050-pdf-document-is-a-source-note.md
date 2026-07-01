# 0050 — A PDF document is a `type='source'` note with a document-level locator

Status: accepted (v0.6.4)

## Context

In v0.6 (pdf-slim-slice) a PDF was ephemeral: opening a file created a `pdf_documents`
row (`0007_pdf_documents.sql`) and held it open in the right-dock reader, but the
document itself had **no presence in the feed and no note identity**. Selecting text
created a `source_kind='pdf'` excerpt note, but the parent document was not a note —
so the excerpt had no thread to attach to, could not be a `comment-on` child of the
document, and vanished from view the moment the dock was closed.

To thread a PDF (v0.6.4 goal: "A PDF persists in the feed as a media note"), the
document must be a note. The existing schema already supports this: `notes.source_kind`
accepts `'pdf'`; the `source_locator` JSON TEXT column already holds `PdfLocator`
(Zod discriminated union); and `pdf_documents.id` is available as a join key. The v0.2
`type='source'` / `source_kind='youtube'` pattern is the direct precedent.

The design tension is the locator shape. A *document-level* anchor has no page, no
rect, no quote — those fields are specific to excerpts. The original `PdfLocator` Zod
type required `page`, `rect`, `quote`, `prefix`, `suffix`. Widening to optional is a
**validation trade-off** that must be recorded.

## Decision

**One `type='source'`, `source_kind='pdf'` note per open `pdf_id`, created (idempotently)
when the PDF is first opened in the reader, persisted in the feed as a `PdfFeedNote`
card.**

### Locator shape

The document-level locator is `{ media: 'pdf', pdf_id: string }` with no page, rect,
or text fields. To accommodate it, `PdfLocator` is widened so `page`, `rect`, `quote`,
`prefix`, and `suffix` are **optional** (previously required). The Zod type now
discriminates by presence: `page == null` → document card; `page != null` → excerpt.

**Accepted trade-off:** widening these fields means a malformed excerpt locator (one
that drops `page` accidentally) could pass Zod validation and render as a document card
instead of an excerpt. This is accepted because excerpt locators are **constructed
internally** by the excerpt-creation path (`PdfReader.tsx`) and are never deserialized
from user-supplied JSON. The risk is bounded to an internal programming error, not an
external data integrity threat.

### Identity and idempotency

The document note's body is empty; its slug is a stable UUID (`uuidv7()`) generated
once and stored in the `notes` row. Its display title comes from
`pdf_documents.title` via the standard `deriveTitle` path (ADR 0039).

Import idempotency is enforced by `getSourceNoteByPdfId` in
`src/main/db/queries/notes.ts`, which runs:

```sql
SELECT * FROM notes
WHERE type = 'source' AND source_kind = 'pdf'
  AND json_extract(source_locator, '$.pdf_id') = ?
LIMIT 1
```

Opening the same PDF a second time finds the existing note and returns it rather than
creating a duplicate. The `comment-on` thread accretes onto the same root note across
sessions.

### Schema

No migration. `pdf_documents` retains its role as metadata-only storage (title,
page count, file path). The join between the feed note and the document record is:
`json_extract(notes.source_locator, '$.pdf_id') → pdf_documents.id`. There is no
`pdf_documents.note_id` back-reference column.

Excerpts (page-bearing locators) become `type='claim'` `comment-on` children of the
document note (see ADR 0051). Pre-v0.6.4 excerpt notes (which carry a page-bearing
locator but were never `comment-on` children of a document note) fall through to the
existing text-bubble rendering path; no migration is needed to handle them gracefully.

## Alternatives

- **A second Zod `pdf` union member discriminated by a `kind` field** — considered.
  Keeping `PdfLocator` for excerpts and adding a separate `PdfDocumentLocator` with a
  `kind: 'document'` discriminant would preserve the original required-fields
  validation. Rejected because `SourceLocator` is a `z.discriminatedUnion('media', …)`
  (youtube | pdf) with a single flat `pdf` member — document vs excerpt is distinguished
  informally by the presence of `page`, not by a formal discriminant. Splitting the pdf
  member into document/excerpt sub-types via a `kind` field would need either a nested
  discriminated union plus a back-fill of `kind: 'excerpt'` onto all existing excerpt
  locators, or abandoning the clean `discriminatedUnion` for a hand-rolled `.refine`. The
  optional-fields widening is lighter and the risk is bounded (see above).

- **`pdf_documents.note_id` back-reference column** — considered. A foreign-key column
  pointing from the document record back to its note would make the join SQL-native and
  avoid the `json_extract`. Rejected because it requires a schema migration (`ALTER
  TABLE pdf_documents ADD COLUMN note_id TEXT REFERENCES notes(id)`) and the project
  policy for v0.6.4 was no schema migration. The `json_extract` path is a small
  performance cost and acceptable for the lookup (one row, one open per session).

- **Keep the PDF ephemeral; thread only the excerpts** — rejected. Without a document
  note, there is no root for a `comment-on` thread, and the user loses the ability to
  write notes *about* the document itself (as opposed to about a specific excerpt). This
  is the direct requirement: "A PDF persists in the feed as a media note."

## Consequences

- **PDFs persist as `PdfFeedNote` cards** in the rolling feed. Reopening the same file
  in a new session accretes excerpts onto the same note thread rather than orphaning
  them.
- **The `page == null` discriminator** in `PdfFeedNote.tsx` and rendering logic is the
  canonical test for "this is a document card vs. an excerpt." It must be preserved in
  any future reshaping of the locator type.
- **PdfLocator validation is slightly weaker** — see trade-off discussion above.
- **Pre-v0.6.4 excerpt notes** (page-bearing, not `comment-on` children of a document
  note) continue to render correctly via the existing text-bubble fallback. No data
  migration needed.
- **Excerpts are now `comment-on` children** of the document note (ADR 0051). The v0.6
  behavior — excerpt placed directly on the canvas without a thread link — is superseded
  on first open after upgrade.

## Sources

- Commit `1752f20` — "PdfLocator excerpt fields optional for document-level anchor (B3)"
- Commit `2d08b0d` — "getSourceNoteByPdfId resolver + IPC + test mocks (B3)"
- Commit `cb10416` — "a PDF becomes a source note in the feed on open (B3)"
- Commit `20833f3` — "PdfFeedNote card; page-absent discriminator vs excerpts (B3)"
- Commit `cc04184` — "excerpt posts a comment-on child; conditional canvas place (B4)"
- `docs/specs/v0.6.4-notes-as-threads.md` §Data model; §The model
- `adrs/0043-pdf-engine-pdfjs-dist.md` — `pdf_documents` table origin
- `adrs/0039-slug-reuse-for-title-search.md` — `deriveTitle` path for display title
