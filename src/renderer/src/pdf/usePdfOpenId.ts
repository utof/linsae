/**
 * Open-PDF id, persisted in the SQLite app_settings store (`pdf.openDocId`) so
 * the right dock restores on boot (spec §6). DB state ⇒ react-query (mirrors
 * use-setting.ts's rationale), NOT a localStorage pref.
 * @see docs/specs/v0.6-pdf-slim-slice.md §6
 * @see src/renderer/src/lib/use-setting.ts
 */
import { useCallback } from 'react'
import { useSetSetting, useSetting } from '../lib/use-setting'

/** The currently-open PDF id, or null when no PDF is open. */
export function usePdfOpenId(): string | null {
  return useSetting<string | null>('pdf.openDocId', null)
}

/**
 * Returns a setter for the open-pdf id (pass null to close). Memoized so the
 * command-registration effect and the Dock's onClose don't churn each render —
 * `mutateAsync` is itself a stable reference across renders (TanStack Query v5).
 */
export function useOpenPdf(): (pdfId: string | null) => Promise<void> {
  const setSetting = useSetSetting('pdf.openDocId')
  return useCallback(
    async (pdfId) => {
      await setSetting.mutateAsync(pdfId)
    },
    [setSetting.mutateAsync],
  )
}
