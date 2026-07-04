import { useQuery } from '@tanstack/react-query'
import {
  ComposerDraftFeedV1Schema,
  ComposerDraftThreadV1Schema,
  DockLayoutV1Schema,
  FeedScrollV1Schema,
  PdfViewV1Schema,
  safeParseOr,
  ThreadScrollV1Schema,
  UiSessionV1Schema,
} from '../../../shared/zod-schemas'
import { api } from '../lib/api'
import { ALL_SESSION_KEYS, SETTING_KEYS, type SessionSnapshot } from './keys'

/** One batched boot read of every session key, each Zod-safe-parsed (or defaulted).
 *  Boot gate: hold the first render of restorable surfaces on `isSuccess`.
 *  NOTE: boot-initial values only — re-reads never reflect later `settings.set` writes
 *  (writers don't update this query's cache). Consumers must seed local state from it, not
 *  treat it as live truth.
 *  @see docs/specs/v0.7-session-persistence.md §Architecture */
export function useSessionSnapshot() {
  return useQuery<SessionSnapshot>({
    queryKey: ['session-snapshot'],
    staleTime: Number.POSITIVE_INFINITY, // read once at boot; writers own updates
    queryFn: async () => {
      const { values } = await api.settings.getMany([...ALL_SESSION_KEYS])
      const v = (k: string) => values[k]
      return {
        dockLayout: safeParseOr(DockLayoutV1Schema, v(SETTING_KEYS.dockLayout), null),
        uiSession: safeParseOr(UiSessionV1Schema, v(SETTING_KEYS.uiSession), null),
        feedScroll: safeParseOr(FeedScrollV1Schema, v(SETTING_KEYS.feedScroll), null),
        threadScroll: safeParseOr(ThreadScrollV1Schema, v(SETTING_KEYS.threadScroll), {}),
        draftFeed: safeParseOr(ComposerDraftFeedV1Schema, v(SETTING_KEYS.draftFeed), null),
        draftThread: safeParseOr(ComposerDraftThreadV1Schema, v(SETTING_KEYS.draftThread), {}),
        pdfView: safeParseOr(PdfViewV1Schema, v(SETTING_KEYS.pdfView), {}),
      }
    },
  })
}
