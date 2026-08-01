/**
 * The circular accent "send" button shared by the feed {@link Composer}, the
 * YouTube {@link ThreadComposer} and the plain/PDF {@link SimpleComposer}.
 * Extracted so the three composers (which are separate components — they share
 * patterns, not code) don't each re-style the same affordance.
 *
 * @see src/renderer/src/composer/Composer.tsx
 * @see src/renderer/src/thread/ThreadComposer.tsx
 * @see src/renderer/src/thread/SimpleComposer.tsx
 */
import { Send } from 'lucide-react'

export interface SendButtonProps {
  onClick: () => void
  /** Accessible label (also the tooltip when `title` is omitted). */
  label: string
  /** Optional tooltip override (e.g. "send ↵"). */
  title?: string
}

/** @see SendButtonProps */
export function SendButton({ onClick, label, title }: SendButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: 'var(--r-pill)',
        border: 0,
        background: 'var(--accent)',
        color: '#fff',
        cursor: 'pointer',
      }}
    >
      <Send size={15} />
    </button>
  )
}
