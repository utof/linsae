/**
 * Dynamic command registry — the codebase's first zustand store (client UI
 * state ONLY; all DB state stays react-query). Contexts (canvas, feed,
 * focused-note) register/unregister their commands on mount/context-change, so
 * the set is genuinely mutable app-global state (spec decision 2 → a store, not
 * a static array). `Command.run` is sync-or-async-agnostic so a future global-
 * undo "Undo"/"Redo" command slots in with no registry change.
 * @see docs/specs/v0.5-command-search.md §4
 * @see adrs/0040-command-palette-generalization-and-zustand.md
 */
import { create } from 'zustand'

export interface Command {
  id: string
  label: string
  /** Hotkey hint shown on the row, e.g. '⌘O'. */
  hint?: string
  group?: string
  run: () => void | Promise<void>
  /** Contextual gate — when present and false, the command is hidden. */
  when?: () => boolean
}

interface CommandStore {
  /** id → Command. A Map keeps register/unregister O(1) + id-unique. */
  registry: Map<string, Command>
  register: (command: Command) => void
  unregister: (id: string) => void
  /** Snapshot of registered commands (insertion order), for the palette. */
  commands: () => Command[]
  /** Test-only: clear the registry. */
  reset: () => void
}

export const useCommandStore = create<CommandStore>()((set, get) => ({
  registry: new Map(),
  register: (command) =>
    set((s) => {
      const next = new Map(s.registry)
      next.set(command.id, command) // re-register replaces (idempotent by id)
      return { registry: next }
    }),
  unregister: (id) =>
    set((s) => {
      if (!s.registry.has(id)) return s
      const next = new Map(s.registry)
      next.delete(id)
      return { registry: next }
    }),
  commands: () => [...get().registry.values()],
  reset: () => set({ registry: new Map() }),
}))
