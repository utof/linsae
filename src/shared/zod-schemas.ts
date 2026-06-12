/**
 * Zod schemas for every IPC channel's input (and the core NoteSchema).
 *
 * Why: Zod is used at the IPC boundary so that the main process can
 * parse/validate renderer inputs at runtime, not just at compile time.
 * See docs/plans/v0.1-rolling-feed-and-search.md §Task 6 Step 2.
 *
 * Zod v4 API verification (via context7 /colinhacks/zod/v4.0.1):
 *   - z.enum([...])          — unchanged from v3 (api.mdx)
 *   - z.object({})           — unchanged from v3
 *   - z.string().min(n)      — unchanged from v3
 *   - z.number().int()       — unchanged from v3 (packages/v3.mdx APIDOC)
 *   - z.number().nonnegative() — unchanged from v3 (packages/v3.mdx APIDOC)
 *   - z.number().positive()  — unchanged from v3 (packages/v3.mdx APIDOC)
 *   - z.number().max(n)      — alias for .lte(n), unchanged from v3
 *   - .nullable()            — unchanged from v3 (packages/v3.mdx)
 *   - .optional()            — unchanged from v3 (packages/v3.mdx)
 *   - .default(value)        — unchanged from v3 (packages/v3.mdx)
 *   Only breaking change in v4 was z.function() API — not used here.
 */
import { z } from 'zod'

/**
 * Discriminated union of valid note types.
 *
 * Why: mirrors the NoteType union in src/shared/types.ts and the CHECK
 * constraint in the notes SQLite table. Used as a sub-schema by every
 * input schema below so the enum is defined exactly once. Not exported —
 * external callers go through the input-schema wrappers.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
const NoteTypeSchema = z.enum(['claim', 'question', 'source'])

/**
 * SourceLocator — what external thing a note is anchored to (JSON TEXT in
 * notes.source_locator). Media-agnostic (spec §Forward direction); v0.2.0 =
 * youtube only; `t` (sec) omitted for anchorless comment-notes.
 * @see docs/specs/v0.2-youtube-annotation.md §Data model
 * Why: not exported — its only current consumer is the Notes create/update
 * schemas in this file. Re-export when a cross-file consumer lands (Plan 3 /
 * reconcile validation) per the export-with-consumer (knip) discipline.
 */
const SourceLocatorSchema = z.object({
  media: z.literal('youtube'),
  video_id: z.string().min(1),
  t: z.number().nonnegative().optional(),
})

/**
 * Input schema for the `notes:list` IPC channel.
 *
 * Why: `limit` caps the page size so the renderer cannot request an unbounded
 * result set. `before` is an optional cursor (Unix ms timestamp) for
 * infinite-scroll pagination.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const NotesListInputSchema = z.object({
  // Default to the max page size: `listNotes` returns the NEWEST `limit` notes, so
  // a small default would hide a user's older notes behind the most recent N. 500
  // covers most personal vaults in one page until scroll-back pagination (#20).
  limit: z.number().int().positive().max(500).default(500),
  before: z.number().int().nonnegative().optional(),
})

/**
 * Input schema for the `notes:create` IPC channel.
 *
 * Why: body must be non-empty for plain notes (no source_kind), but a
 * video-anchored note (source_kind is set) may legitimately have an empty
 * body — e.g. a source note created on URL-paste or a screenshot comment
 * with no caption yet. Non-anchored notes still require a non-empty,
 * non-whitespace body. type defaults to 'claim' so callers that omit it
 * (quick-capture flow) get a sensible default without an extra round-trip.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const NotesCreateInputSchema = z
  .object({
    body: z.string(),
    type: NoteTypeSchema.default('claim'),
    source_kind: z.literal('youtube').optional(),
    source_locator: SourceLocatorSchema.optional(),
    commentOn: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.source_kind && v.body.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'body required' })
    }
  })

/**
 * Input schema for the `notes:update` IPC channel.
 *
 * Why: all fields are required — the renderer must always supply the full
 * updated note to avoid partial-update confusion. body may be empty only
 * when source_kind is set (video-anchored note); non-anchored notes still
 * require a non-empty, non-whitespace body.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const NotesUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    type: NoteTypeSchema,
    source_kind: z.literal('youtube').optional(),
    source_locator: SourceLocatorSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.source_kind && v.body.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'body required' })
    }
  })

/**
 * Minimal schema for channels that operate on a single note by ID.
 *
 * Why: used by `notes:delete` and `notes:get` to avoid duplicating the
 * `{ id: z.string().min(1) }` pattern across multiple handler files.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const NoteIdSchema = z.object({ id: z.string().min(1) })

/**
 * Input schema for the `search:run` IPC channel.
 *
 * Why: query must be non-empty (FTS5 rejects empty strings); limit caps
 * result set size to prevent UI freezes on very broad queries.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const SearchRunInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
})

/**
 * Input schema for the `links:backlinks` IPC channel.
 *
 * Why: uses `noteId` (camelCase) rather than `id` to distinguish this from
 * NoteIdSchema — backlinks are looked up by the target note's ID, not the
 * link row's own ID.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 (handler registration)
 */
export const BacklinksInputSchema = z.object({ noteId: z.string().min(1) })

/**
 * Input schema for the `links:resolve` IPC channel.
 *
 * Why: wikilink resolution takes a slug (the human-readable identifier
 * written in [[double brackets]]) and returns the matching note, if any.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 (handler registration)
 */
export const ResolveInputSchema = z.object({ slug: z.string().min(1) })

/** `youtube:capture` input. videoId/t give the orphan attachment its provenance. */
export const CaptureInputSchema = z.object({
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  videoId: z.string().min(1),
  t: z.number().nonnegative(),
})

/** `youtube:fetchOEmbed` input. */
export const FetchOEmbedInputSchema = z.object({ videoId: z.string().min(1) })

/** `attachments:list` filter — every field optional (spec AttachmentsApi.list). */
export const AttachmentsListInputSchema = z.object({
  orphans: z.boolean().optional(),
  videoId: z.string().min(1).optional(),
  titleLike: z.string().min(1).optional(),
  noteId: z.string().min(1).optional(),
})

/** `attachments:attachToNote` input. */
export const AttachToNoteInputSchema = z.object({
  attachmentId: z.string().min(1),
  noteId: z.string().min(1),
})

/**
 * `videoSources:upsert` input. sourceKind is typed for forward-compat but the
 * v0.2.0 validator accepts only 'youtube' (spec line 350: widen when local ships).
 */
export const VideoSourcesUpsertInputSchema = z.object({
  videoId: z.string().min(1),
  sourceKind: z.literal('youtube'),
  // oEmbed-derived metadata, all optional — the Plan 1 wrapper COALESCEs each, so
  // a metadata-less re-upsert never wipes a cached title (spec §Add a video). The
  // renderer fetches oEmbed then upserts with these set; Plan 3 needs no schema edit.
  title: z.string().optional(),
  channel: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  durationSec: z.number().int().nonnegative().optional(),
})

/** `videoSources:get` input. */
export const VideoSourcesGetInputSchema = z.object({ videoId: z.string().min(1) })

/**
 * Input schema for the `links:commentsOf` IPC channel.
 *
 * Why `noteId` (not `slug`): the renderer holds note ids (UUIDs), not slugs.
 * Slug resolution happens in the handler after Zod parse, mirroring the
 * `links:backlinks` pattern — see src/main/ipc/notes.ts.
 * @issue utof/linsae#36
 */
export const CommentsOfInputSchema = z.object({ noteId: z.string().min(1) })

/**
 * `youtube:saveOverlay` input — write or clear the SVG sidecar for a screenshot.
 *
 * Why `startsWith('<svg')`: rejects non-SVG payloads at the boundary (a plain
 * string accepted by `z.string()` could be anything; the check is a cheap guard
 * against accidentally sending JSON or other text). `max(512_000)` caps sidecar
 * size at ~0.5 MB — generous for screen annotation but protects against runaway
 * serialization. `svg: null` is the "clear overlay" sentinel.
 *
 * Why `attachmentId` not `id`: mirrors `AttachToNoteInputSchema` which uses
 * `attachmentId` to distinguish from a note id at call sites.
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract
 */
export const SaveOverlayInputSchema = z.object({
  attachmentId: z.string(),
  svg: z.string().startsWith('<svg').max(512_000).nullable(),
})

/**
 * `attachments:remove` input — soft-delete an orphan attachment and its sidecar.
 *
 * Why: the single Discard entry point for a never-posted screenshot
 * (capture-time Esc → Discard).
 *
 * @see docs/specs/v0.2.5-screenshot-annotation.md §IPC contract
 */
export const AttachmentRemoveInputSchema = z.object({ id: z.string() })

/**
 * Shared canvas key — every canvas channel except getState/setState carries the
 * opaque (canvasId, arrangementId) pair (vision principles 3-4). Spread into the
 * schemas below so the pair is defined exactly once. Not a schema itself.
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
const CanvasKey = {
  canvasId: z.string().min(1),
  arrangementId: z.string().min(1),
}

/** canvas:listLayouts input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasListLayoutsInputSchema = z.object({ ...CanvasKey })

/** canvas:edges input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasEdgesInputSchema = z.object({ ...CanvasKey })

/** canvas:shelveNote input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasShelveNoteInputSchema = z.object({ ...CanvasKey, noteId: z.string().min(1) })

/** canvas:placeNote input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasPlaceNoteInputSchema = z.object({
  ...CanvasKey,
  noteId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
})

/** canvas:moveNotes input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasMoveNotesInputSchema = z.object({
  ...CanvasKey,
  moves: z
    .array(z.object({ noteId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }))
    .min(1),
})

/** canvas:unplaceNotes / canvas:removeNotes input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasNoteIdsInputSchema = z.object({
  ...CanvasKey,
  noteIds: z.array(z.string().min(1)).min(1),
})

/** canvas:restoreLayouts input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasRestoreLayoutsInputSchema = z.object({
  ...CanvasKey,
  rows: z
    .array(
      z.object({
        noteId: z.string().min(1),
        x: z.number().finite().nullable(),
        y: z.number().finite().nullable(),
        createdAt: z.number().int(),
        placedAt: z.number().int().nullable(),
      }),
    )
    .min(1),
})

/** canvas:getState input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasGetStateInputSchema = z.object({ canvasId: z.string().min(1) })

/** canvas:setState input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasSetStateInputSchema = z.object({
  canvasId: z.string().min(1),
  camera_x: z.number().finite(),
  camera_y: z.number().finite(),
  zoom: z.number().finite().positive(),
})

/** canvas:recentOnCanvas input. @see docs/specs/v0.4-canvas-mvp.md §2 */
export const CanvasRecentInputSchema = z.object({
  ...CanvasKey,
  limit: z.number().int().min(1).max(50).default(8),
})
