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
  limit: z.number().int().positive().max(500).default(100),
  before: z.number().int().nonnegative().optional(),
})

/**
 * Input schema for the `notes:create` IPC channel.
 *
 * Why: body must be non-empty; type defaults to 'claim' so callers that omit
 * it (quick-capture flow) get a sensible default without an extra round-trip.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const NotesCreateInputSchema = z.object({
  body: z.string().min(1),
  type: NoteTypeSchema.default('claim'),
  source_kind: z.literal('youtube').optional(),
  source_locator: SourceLocatorSchema.optional(),
  commentOn: z.string().min(1).optional(),
})

/**
 * Input schema for the `notes:update` IPC channel.
 *
 * Why: all three fields are required — the renderer must always supply the
 * full updated note to avoid partial-update confusion.
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 6
 */
export const NotesUpdateInputSchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  type: NoteTypeSchema,
  source_kind: z.literal('youtube').optional(),
  source_locator: SourceLocatorSchema.optional(),
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
