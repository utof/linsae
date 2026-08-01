# 0023 — Feed multi-select: gutter drag + modal selection mode

Status: accepted (v0.2.3)

## Context
Users want Telegram-style bulk operations on feed notes (reference
screenshot in docs/plans/v0.2.3-multi-select.md): drag in the empty area
right of the bubbles to select a run of notes, see right-edge checkmarks +
row highlights, and act from a top bar (copy / delete / cancel).

## Decision
- Selection state (`ReadonlySet<string>`) lives in `Feed`, ephemeral;
  selection MODE is derived (`size > 0`) — deselecting the last row exits.
- Entry point: vertical drag (≥5px) starting on non-interactive feed
  surface; rubber-band = drag-start base ∪ rows in range, hit-tested
  against `getVirtualItems()` spans in content coordinates.
- Mode is MODAL: a capture-phase click handler on each virtual-row wrapper
  toggles membership and stops propagation, so bubble focus / hover-bar /
  card actions are inert while selecting; `NoteBubble` hides its hover bar
  and context menu via a `selecting` prop.
- Bulk actions: copy (bodies in feed order; video cards contribute
  `https://youtu.be/<id>`), delete behind the repo's 2s armed-confirm
  idiom, cancel + Esc.
- Right-click is selection-aware: selected row → bulk menu (copy / delete /
  clear; single-click delete — a named menu item is its own confirmation,
  per NoteContextMenu's rationale); unselected row while selecting →
  Select / Select-up-to (nearest-selected bridge); bare gutter → Select.
  All through a generic `ContextMenuShell` extracted from NoteContextMenu
  so every right-click menu shares one implementation.
- Keyboard layer (Task 6.5): plain-letter mnemonics (`c` copy / `d` armed
  delete) on the selection bar, mnemonic underlines + plain-letter shortcuts in
  every context menu, ArrowDown/ArrowUp focus movement, Shift+Arrow selection
  extension, and `x` to toggle the focused note — all via Feed-local document
  keydown listeners, guarded to never fire while typing (target in
  `textarea/input/[contenteditable]`) or under a non-Shift modifier.
  An open context menu owns the keyboard (capture-phase listener +
  `stopImmediatePropagation`), making Esc two-step: the first Escape closes
  the menu only, the second exits selection mode.

## Alternatives
- **setPointerCapture-based drag** — window pointermove/up listeners chosen
  instead; matches `useScrollThumb` and is happy-dom-testable.
- **Always-available checkbox on hover** (Notion-style) — rejected: feed
  stays visually quiet (CLAUDE.md design tone), mode is explicit.
- **Shift-click range selection** — deferred; composable later on top of the
  same `selectedIds` state.
- **Native Electron menu / dialog for bulk delete** — rejected: armed-confirm
  is the established in-app idiom (NoteBubble trash), no IPC round-trip.

## Consequences
- Esc while a note is focused AND selection active clears both (Feed's
  document listener + App's hotkey ladder both fire) — accepted nit.
- Drag hit-testing sees only the rendered window (overscan 8); edge
  auto-scroll recomputes per scroll tick so fast drags cannot skip rows.
- The selection bar overlays the feed's top inside the 720px column; the
  WindowFrame is untouched (drag region + traffic lights stay native).

## Sources
- docs/plans/v0.2.3-multi-select.md (user screenshot + scope)
- src/renderer/src/components/ScrollArea.tsx `onThumbPointerDown` (drag pattern)
- adrs/0005-tanstack-virtual.md (virtual item geometry contract)
