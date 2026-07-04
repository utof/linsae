// src/renderer/src/panes/DockTabs.tsx
import { X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { getPane } from './Pane'

interface DockTabsProps {
  paneIds: string[]
  activeId: string
  onActivate: (paneId: string) => void
  onClose: (paneId: string) => void
}

/** Quiet text-label tab strip; rendered by Dock only at ≥2 panes (spec §2).
 *  Left/Right arrows move the active tab. @see docs/specs/v0.6.2-dock-shell.md §2 */
export function DockTabs({
  paneIds,
  activeId,
  onActivate,
  onClose,
}: DockTabsProps): React.JSX.Element {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = paneIds.indexOf(activeId)
    const next = e.key === 'ArrowRight' ? paneIds[i + 1] : paneIds[i - 1]
    if (next) {
      e.preventDefault()
      onActivate(next)
    }
  }
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        height: 'var(--topbar-h)',
        borderBottom: '1px solid var(--border-0)',
        background: 'var(--bg-1)',
      }}
    >
      {paneIds.map((id) => {
        const active = id === activeId
        const title = getPane(id)?.title ?? id
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation handled by tablist onKeyDown; individual tab divs do not need redundant key handlers
          <div
            key={id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onActivate(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: '0 var(--space-4)',
              cursor: 'pointer',
              fontSize: 'var(--t-13)',
              // Weight + color follow the v21 tab (right-pane.jsx `PaneTab`): active =
              // semibold on --fg-0, inactive = medium on --fg-2 — a clear, "obey-er"
              // hierarchy instead of the old flat 400/--fg-1. @see v21-design-system
              fontWeight: active ? 600 : 500,
              color: active ? 'var(--fg-0)' : 'var(--fg-2)',
              borderBottom: active ? '1px solid var(--accent)' : '1px solid transparent',
            }}
          >
            <span>{title}</span>
            <button
              type="button"
              aria-label={`close ${title}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(id)
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                color: 'var(--fg-2)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {/* Lucide X (design's close glyph — see PaneTab `IconBtn name="x"`),
                  not the thin literal `×`. */}
              <X size={14} aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
