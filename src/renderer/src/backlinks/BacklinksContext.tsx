import { createContext, useContext } from 'react'

/** The focus the backlinks list needs but does not own — App provides it around
 *  the dock; the overlay provides it locally. @see docs/specs/v0.6.2-dock-shell.md §3 */
export interface BacklinksContextValue {
  /** Note whose incoming wikilinks are listed (null ⇒ list is empty/disabled). */
  focusedId: string | null
  /** Navigate to a backlinked note. */
  onJump: (noteId: string) => void
}

/** Default = no focus, no-op jump (a stray mount renders empty, never throws). */
export const BacklinksContext = createContext<BacklinksContextValue>({
  focusedId: null,
  onJump: () => {},
})

/** Read the backlinks focus context. @see BacklinksContext */
export function useBacklinks(): BacklinksContextValue {
  return useContext(BacklinksContext)
}
