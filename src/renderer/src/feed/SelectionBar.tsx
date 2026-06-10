// src/renderer/src/feed/SelectionBar.tsx
import { Copy, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  count: number
  onCopy: () => void
  onDelete: () => void
  onCancel: () => void
}

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: 0,
  background: 'transparent',
  borderRadius: 6,
  padding: '6px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg-0)',
  cursor: 'pointer',
}

/**
 * Bulk-action bar shown while feed multi-select is active (Telegram's
 * forward/delete/cancel header, adapted: "forward" becomes "copy" — the
 * nearest meaningful analog in a local notes app).
 *
 * Why the 2-second armed confirm on delete (first click arms red, second
 * fires): bulk delete is the most destructive action in the app and the
 * armed pattern is already the established confirmation idiom — see
 * `NoteBubble.tsx`'s trash button rationale. A modal would be heavier than
 * the v21 aesthetic wants.
 *
 * @see docs/plans/v0.2.3-multi-select.md
 */
export function SelectionBar({ count, onCopy, onDelete, onCancel }: Props) {
  const [armed, setArmed] = useState(false)
  const armTimer = useRef<number | null>(null)

  // Clear the arm timer on unmount so a pending timeout can't setState on an
  // unmounted bar (the bar unmounts whenever the selection empties).
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
    },
    [],
  )

  const handleDelete = () => {
    if (armed) {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      setArmed(false)
      onDelete()
      return
    }
    setArmed(true)
    armTimer.current = window.setTimeout(() => setArmed(false), 2000)
  }

  return (
    <div
      data-selection-bar
      style={{
        position: 'absolute',
        top: 8,
        left: 0,
        right: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: '#fff',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '4px 8px',
        boxShadow: 'var(--shadow-1)',
      }}
    >
      <button type="button" aria-label={`copy ${count} notes`} onClick={onCopy} style={buttonStyle}>
        <Copy size={14} />
        copy {count}
      </button>
      <button
        type="button"
        aria-label={armed ? `confirm delete ${count} notes` : `delete ${count} notes`}
        onClick={handleDelete}
        style={{
          ...buttonStyle,
          background: armed ? '#FDECEC' : 'transparent',
          color: armed ? '#E5484D' : 'var(--fg-0)',
        }}
      >
        <Trash2 size={14} />
        {armed ? `delete ${count}?` : `delete ${count}`}
      </button>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        aria-label="cancel selection"
        onClick={onCancel}
        style={{ ...buttonStyle, color: 'var(--fg-2)' }}
      >
        <X size={14} />
        cancel
      </button>
    </div>
  )
}
