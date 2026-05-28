import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, type RenderOptions, type RenderResult, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, vi } from 'vitest'
import type { Note, SearchHit } from '../src/shared/types'

// jsdom lacks ResizeObserver, but @radix-ui/react-dialog (transitively used by
// cmdk's Command.Dialog) calls `new ResizeObserver(...)` during mount. A no-op
// stub is sufficient for component tests that don't assert on resize behaviour.
// Why a stub (not a real impl): jsdom never lays out, so observed sizes would
// always be 0 — tests that actually care about size mock per-test instead.
// @see https://github.com/jsdom/jsdom/issues/3368
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub
}

/**
 * Wraps UI in a fresh QueryClientProvider for component tests.
 * @see src/shared/types.ts
 * Why: tests must not share query-cache state; new QueryClient per render.
 * Why explicit return type: avoids TS2742 — the inferred RenderResult references
 * @testing-library/dom queries via pnpm's deep store path, which TS warns is not portable.
 */
export function renderWithProviders(ui: ReactNode, opts?: RenderOptions): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>, opts)
}

/**
 * Shape of the mocked window.api injected by installMockApi.
 * Mirrors the IPC surface defined in src/preload/index.ts (Task 5).
 */
export interface MockApi {
  notes: {
    list: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  search: { run: ReturnType<typeof vi.fn> }
  links: { backlinks: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> }
  system: {
    revealNotesFolder: ReturnType<typeof vi.fn>
    openLogsFolder: ReturnType<typeof vi.fn>
    getReconcileSkipped: ReturnType<typeof vi.fn>
    window: {
      minimize: ReturnType<typeof vi.fn>
      toggleMaximize: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }
  }
}

/**
 * Installs a typed vi.fn() mock at window.api before each component test.
 * Call inside beforeEach; pass partial overrides to specialise individual fns.
 * @see tests/setup.tsx
 * Why: component tests run in jsdom — no Electron preload — so window.api must
 * be provided manually. Using vi.fn() lets tests assert call args and return values.
 */
export function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    notes: {
      list: vi.fn(async (): Promise<Note[]> => []),
      get: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    search: { run: vi.fn(async (): Promise<SearchHit[]> => []) },
    links: {
      backlinks: vi.fn(async (): Promise<Note[]> => []),
      resolve: vi.fn(async () => null),
    },
    system: {
      revealNotesFolder: vi.fn(async () => ({ ok: true })),
      openLogsFolder: vi.fn(async () => ({ ok: true })),
      getReconcileSkipped: vi.fn(async () => 0),
      window: {
        minimize: vi.fn(async () => ({ ok: true })),
        toggleMaximize: vi.fn(async () => ({ ok: true })),
        close: vi.fn(async () => ({ ok: true })),
      },
    },
    ...overrides,
  }
  ;(globalThis as unknown as { window: { api: MockApi } }).window ||= {} as { api: MockApi }
  ;(globalThis as unknown as { window: { api: MockApi } }).window.api = api
  return api
}

// Reset vi.fn() call histories AND unmount any DOM rendered via RTL between
// tests so previous-test state never leaks. `cleanup()` is what RTL would
// auto-register if vitest globals were on (vitest.config.ts sets
// `globals: false` so the auto-cleanup is inert) — see issue #16.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
