import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderOptions, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import type { Note, SearchHit } from '../src/shared/types'

/**
 * Wraps UI in a fresh QueryClientProvider for component tests.
 * @see src/shared/types.ts
 * Why: tests must not share query-cache state; new QueryClient per render.
 */
export function renderWithProviders(ui: ReactNode, opts?: RenderOptions) {
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
  system: { revealNotesFolder: ReturnType<typeof vi.fn>; openLogsFolder: ReturnType<typeof vi.fn> }
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
    },
    ...overrides,
  }
  ;(globalThis as unknown as { window: { api: MockApi } }).window ||= {} as { api: MockApi }
  ;(globalThis as unknown as { window: { api: MockApi } }).window.api = api
  return api
}
