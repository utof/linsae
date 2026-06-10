// src/renderer/src/feed/SelectionBar.tsx
import { Copy, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

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

const underlineStyle: React.CSSProperties = { textUnderlineOffset: 2 }

/**
 * True when a keyboard event originates inside an editable field, so a global
 * letter shortcut must yield to it. Shared with the Feed's keyboard layer —
 * Why: a stray `d` while composing must type "d", never bulk-delete (mirrors
 * src/renderer/src/thread/ThreadView.tsx:349's reason for omitting `enableOnFormTags`).
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const el = target as HTMLElement
  return el.closest('textarea, input, [contenteditable="true"]') != null
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
 * Keyboard layer: while mounted, a document-level keydown listener fires the
 * actions on plain letters — `c` → onCopy, `d` → the SAME arm-then-confirm
 * path as clicking delete (so a single `d` arms, a second `d` fires). The
 * visible labels underline that mnemonic letter; cancel shows a small `esc`
 * hint instead (Esc already exits via the Feed's listener). Guarded against
 * modifiers and typing targets so the shortcuts never steal composer input.
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

  // useCallback so the keydown effect below can depend on the stable identity
  // and reuse the EXACT click path (arm → confirm), not a parallel one.
  const handleDelete = useCallback(() => {
    if (armed) {
      if (armTimer.current !== null) clearTimeout(armTimer.current)
      setArmed(false)
      onDelete()
      return
    }
    setArmed(true)
    armTimer.current = window.setTimeout(() => setArmed(false), 2000)
  }, [armed, onDelete])

  // Plain-letter shortcuts while the bar is mounted. Esc is handled by the
  // Feed's own selection listener (it owns the mode), so the bar leaves it
  // alone here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (e.key === 'c') {
        e.preventDefault()
        onCopy()
      } else if (e.key === 'd') {
        e.preventDefault()
        handleDelete()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCopy, handleDelete])

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
        <span>
          <u style={underlineStyle}>c</u>opy {count}
        </span>
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
        <span>
          <u style={underlineStyle}>d</u>elete {count}
          {armed ? '?' : ''}
        </span>
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
        <kbd
          style={{
            marginLeft: 4,
            fontSize: 10,
            padding: '1px 4px',
            borderRadius: 3,
            border: '1px solid var(--border-1)',
            color: 'var(--fg-2)',
          }}
        >
          esc
        </kbd>
      </button>
    </div>
  )
}
