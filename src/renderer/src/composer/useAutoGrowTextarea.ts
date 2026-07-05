import { type RefObject, useLayoutEffect, useRef } from 'react'

/**
 * Cap on the auto-grown textarea height (px). ~10 lines at 14px text + 1.5
 * line-height + inner padding leaves a comfortable Telegram-style draft window
 * before the internal scrollbar kicks in. Past this, the textarea
 * overflow-scrolls inside itself and its container stops pushing the surrounding
 * layout any further. Both the feed {@link Composer} and the YouTube
 * {@link ThreadComposer} used this exact ceiling before they were unified onto
 * this hook, so the constant is centralized here.
 */
const TEXTAREA_MAX_HEIGHT_PX = 220

/**
 * Auto-grow a `<textarea>` to fit its content, capped at `maxHeight`.
 *
 * Returns a ref to attach to the textarea. On every change of `value` it resets
 * the element height to `auto` (so `scrollHeight` reports the natural content
 * height instead of monotonically growing), then clamps to `maxHeight`.
 *
 * Why `useLayoutEffect` (not `useEffect`): it runs synchronously after the DOM
 * mutation and before paint, so the user never sees a one-frame flash of the old
 * height. `value` is a trigger-only dep — the effect reads `el.scrollHeight` via
 * the ref *after* React flushes the controlled value to the DOM.
 *
 * Why this hook exists: the feed `Composer`, the YouTube `ThreadComposer`, and
 * the plain/pdf `SimpleComposer` all need the identical auto-grow behavior. This
 * is the shared unit the three composers adopt (they keep their own bespoke
 * chrome — question mode, chip/camera, minimal — but share this + `SendButton`).
 *
 * @see src/renderer/src/composer/Composer.tsx
 * @see src/renderer/src/thread/ThreadComposer.tsx
 * @see src/renderer/src/thread/SimpleComposer.tsx
 */
export function useAutoGrowTextarea(
  value: string,
  maxHeight: number = TEXTAREA_MAX_HEIGHT_PX,
): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is a trigger-only dep — the effect reads scrollHeight after React flushes the controlled value to the DOM. Without it the textarea would size only on mount.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])
  return ref
}
