/**
 * Singleton TanStack Query client tuned for a local-only data source.
 *
 * @see docs/specs/v0.1-rolling-feed-and-search.md §IPC channels at v0.1
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 22
 */

import { QueryClient } from '@tanstack/react-query'

/**
 * Application-wide QueryClient. Injected at the renderer root by `main.tsx`'s
 * `<QueryClientProvider client={queryClient}>`.
 *
 * Why `staleTime: Infinity`: the data source is a local SQLite DB owned by
 * the main process; there is no remote backend and no concept of "freshness
 * window". Cache invalidation is push-based — mutations call
 * `queryClient.invalidateQueries(...)` explicitly. Default time-based
 * refetching would just thrash the IPC bridge for no observable benefit.
 *
 * Why `refetchOnWindowFocus: false`: same reasoning — focus does not signal
 * that local data became stale; only an explicit mutation does.
 *
 * Why `retry: false`: IPC failures here mean the main process / DB is
 * broken; silent retries would mask the bug. Errors should surface to the
 * UI on the first try.
 *
 * @see https://tanstack.com/query/v5/docs/framework/react/guides/important-defaults
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
})
