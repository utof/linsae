import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from './command-store'
import { useCommandStore } from './command-store'

const cmd = (id: string, over: Partial<Command> = {}): Command => ({
  id,
  label: `Cmd ${id}`,
  run: vi.fn(),
  ...over,
})

beforeEach(() => {
  // reset the store between tests (replace the commands map)
  useCommandStore.getState().reset()
})

describe('useCommandStore', () => {
  it('register adds a command; commands selector lists it', () => {
    useCommandStore.getState().register(cmd('a'))
    expect(
      useCommandStore
        .getState()
        .commands()
        .map((c) => c.id),
    ).toEqual(['a'])
  })
  it('register is idempotent by id (re-register replaces, no dupes)', () => {
    useCommandStore.getState().register(cmd('a', { label: 'First' }))
    useCommandStore.getState().register(cmd('a', { label: 'Second' }))
    const all = useCommandStore.getState().commands()
    expect(all).toHaveLength(1)
    expect(all[0]!.label).toBe('Second')
  })
  it('unregister removes by id', () => {
    useCommandStore.getState().register(cmd('a'))
    useCommandStore.getState().register(cmd('b'))
    useCommandStore.getState().unregister('a')
    expect(
      useCommandStore
        .getState()
        .commands()
        .map((c) => c.id),
    ).toEqual(['b'])
  })
  it('unregister of an absent id is a no-op', () => {
    useCommandStore.getState().register(cmd('a'))
    useCommandStore.getState().unregister('zzz')
    expect(useCommandStore.getState().commands()).toHaveLength(1)
  })
})
