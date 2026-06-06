/**
 * Aggregator for every IPC handler the main process exposes.
 *
 * Why: Task 21 (main lifecycle) calls this single function so the lifecycle
 * code never has to know which channels exist. Adding a new handler family
 * means editing one place rather than `src/main/index.ts`.
 *
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 20 Step 3
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 21
 */

import type Database from 'better-sqlite3'
import type { NotesDir } from '../files/notes-dir'
import { registerMediaIpc } from './media'
import { registerNotesIpc } from './notes'
import { registerSystemIpc } from './system'
import { registerYoutubeAuthIpc } from './youtube-auth'

type DB = Database.Database

/**
 * Registers every IPC channel: notes / search / links via
 * {@link registerNotesIpc}, system / shell via {@link registerSystemIpc},
 * and media / attachments / videoSources via {@link registerMediaIpc}.
 *
 * Why: A single call from the main-process bootstrap keeps channel
 * registration ordering deterministic and avoids the foot-gun where a
 * future contributor wires only half of the surface.
 *
 * @param db - Open better-sqlite3 Database.
 * @param nd - {@link NotesDir} pointed at the user's notes directory.
 * @param notesDir - Absolute path of the notes directory (for shell.openPath).
 * @param logsDir - Absolute path of the logs directory (for shell.openPath).
 * @param reconcileSkipped - Cached startup-reconciler skip count.
 * @param attachmentsDir - Absolute path for captured PNG storage (v0.2).
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/specs/v0.2-youtube-annotation.md §IPC contracts
 */
export function registerAllIpc(
  db: DB,
  nd: NotesDir,
  notesDir: string,
  logsDir: string,
  reconcileSkipped: number,
  attachmentsDir: string,
): void {
  registerNotesIpc(db, nd)
  registerSystemIpc(notesDir, logsDir, reconcileSkipped)
  registerMediaIpc(db, attachmentsDir)
  registerYoutubeAuthIpc()
}
