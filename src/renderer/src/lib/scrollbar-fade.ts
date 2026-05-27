/**
 * Adds a `.scrolled-recently` class to any element that has just scrolled
 * and removes it 800ms after the last scroll event. globals.css uses the
 * class (alongside `:hover`) to fade the scrollbar thumb in/out so
 * scrollbars are quiet by default and only appear when relevant.
 *
 * Why a capture-phase document-level listener (vs per-component wiring):
 * scroll events do not bubble, but capture-phase reaches every element
 * regardless of mount order. Newly-mounted scrollable surfaces (the
 * Virtuoso feed, CommandPalette results, BacklinksPane) get the fade
 * behaviour for free with no per-component code.
 *
 * Why a WeakMap of timer ids: each scrollable element needs its own
 * 800ms timer so one fast-scrolling surface doesn't keep another's fade
 * alive. WeakMap lets the element be garbage-collected when unmounted
 * without us needing teardown — the timer fires (or already fired) and
 * the entry vanishes with the element.
 *
 * @see src/renderer/src/styles/globals.css (::-webkit-scrollbar rules)
 */
const FADE_HOLD_MS = 800
const timers = new WeakMap<Element, number>()

export function installScrollbarFade(): void {
  document.addEventListener(
    'scroll',
    (e) => {
      const target = e.target
      if (!(target instanceof Element)) return
      target.classList.add('scrolled-recently')
      const existing = timers.get(target)
      if (existing !== undefined) clearTimeout(existing)
      const id = window.setTimeout(() => {
        target.classList.remove('scrolled-recently')
        timers.delete(target)
      }, FADE_HOLD_MS)
      timers.set(target, id)
    },
    { capture: true, passive: true },
  )
}
