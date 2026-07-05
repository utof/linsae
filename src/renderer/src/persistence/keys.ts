import type { z } from 'zod'
import type {
  ComposerDraftFeedV1Schema,
  ComposerDraftThreadV1Schema,
  DockLayoutV1Schema,
  FeedScrollV1Schema,
  PdfViewV1Schema,
  ThreadScrollV1Schema,
  UiSessionV1Schema,
} from '../../../shared/zod-schemas'

export const SETTING_KEYS = {
  dockLayout: 'dock.layout.v1',
  uiSession: 'ui.session.v1',
  feedScroll: 'feed.scroll.v1',
  threadScroll: 'thread.scroll.v1',
  draftFeed: 'composer.draft.feed.v1',
  draftThread: 'composer.draft.thread.v1',
  pdfView: 'pdf.view.v1',
} as const

// Deviation from spec §Architecture (noted): the spec folds `pdf.openDocId` into getMany for a
// single boot round-trip; v0.7 leaves `usePdfOpenId`'s existing separate `settings:get`
// (App.tsx) unchanged and defers the fold — one extra small read, not worth the App
// surgery this milestone.

export const ALL_SESSION_KEYS = Object.values(SETTING_KEYS)

export type SessionSnapshot = {
  dockLayout: z.infer<typeof DockLayoutV1Schema> | null
  uiSession: z.infer<typeof UiSessionV1Schema> | null
  feedScroll: z.infer<typeof FeedScrollV1Schema> | null
  threadScroll: z.infer<typeof ThreadScrollV1Schema>
  draftFeed: z.infer<typeof ComposerDraftFeedV1Schema> | null
  draftThread: z.infer<typeof ComposerDraftThreadV1Schema>
  pdfView: z.infer<typeof PdfViewV1Schema>
}
