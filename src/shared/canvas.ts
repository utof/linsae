/**
 * Canvas constants + shared types. canvas_id/arrangement_id are OPAQUE TEXT
 * keys (vision principles 3-4): 'root' today, a note id when threads arrive;
 * 'manual' today, command-generated arrangements later. Every canvas IPC call
 * and query passes these explicitly — no implicit defaults outside this file.
 * Types are appended task-by-task as consumers appear (knip discipline).
 * @see docs/canvas-vision.md §Locked principles 3-4
 * @see docs/specs/v0.4-canvas-mvp.md §2
 */
export const ROOT_CANVAS_ID = 'root'
export const MANUAL_ARRANGEMENT_ID = 'manual'
