import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'

/**
 * Root component stub for v0.1 bootstrap. Renders the notes count via
 * TanStack Query against the IPC bridge — proves the wrapper + provider
 * wiring is alive end-to-end. Replaced by the real feed in Task 24.
 *
 * @see docs/plans/v0.1-rolling-feed-and-search.md §Task 22
 */
export function App() {
  const { data, isLoading } = useQuery({
    queryKey: ['notes'],
    queryFn: () => api.notes.list(),
  })
  return (
    <div style={{ padding: 16, fontFamily: 'var(--font-sans)', color: 'var(--fg-0)' }}>
      <div>linsae — {isLoading ? 'loading…' : `${data?.length ?? 0} notes`}</div>
    </div>
  )
}
