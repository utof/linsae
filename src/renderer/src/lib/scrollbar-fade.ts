/**
 * Adds a `.scrolled-recently` class to the scrollable ancestor of any
 * element the user just wheel-scrolled, and removes it 800ms after the
 * last wheel event. globals.css uses the class (alongside `:hover`) to
 * fade the scrollbar thumb in/out so scrollbars are quiet by default
 * and only appear when relevant.
 *
 * Why `wheel` (and not `scroll`): scroll events fire for ANY scroll
 * source — including programmatic scrolls Virtuoso triggers during
 * reflows (composer grow, window resize, scrollToIndex). Those should
 * NOT surface the scrollbar because the user didn't initiate them.
 * Wheel only fires on user trackpad / mouse-wheel input.
 *
 * Why capture-phase at document level (vs per-component wiring):
 * wheel events do bubble, but capture reaches every element regardless
 * of mount order, so newly-mounted scrollable surfaces (CommandPalette
 * results, BacklinksPane) get the behaviour for free.
 *
 * Why walk up to find a scrollable ancestor: wheel fires on whatever
 * leaf element is under the cursor (a bubble's `<p>`, a list item).
 * The scrollable element is usually a parent. We cache the ancestor
 * per-leaf in a WeakMap so the walk happens once per unique target.
 *
 * Drag-scrolling (grabbing the thumb) is unaffected — the cursor sits
 * over the scrollbar area while dragging, and the parent :hover rule
 * keeps the thumb visible the whole time.
 *
 * @see src/renderer/src/styles/globals.css (::-webkit-scrollbar rules)
 */
const FADE_HOLD_MS = 800
const timers = new WeakMap<Element, number>()
const ancestorCache = new WeakMap<Element, Element | null>()

function findScrollableAncestor(el: Element): Element | null {
  const cached = ancestorCache.get(el)
  if (cached !== undefined) return cached
  let cur: Element | null = el
  while (cur) {
    const cs = getComputedStyle(cur)
    const oy = cs.overflowY
    const ox = cs.overflowX
    if (oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll') break
    cur = cur.parentElement
  }
  ancestorCache.set(el, cur)
  return cur
}

export function installScrollbarFade(): void {
  document.addEventListener(
    'wheel',
    (e) => {
      if (!(e.target instanceof Element)) return
      const ancestor = findScrollableAncestor(e.target)
      if (!ancestor) return
      ancestor.classList.add('scrolled-recently')
      const existing = timers.get(ancestor)
      if (existing !== undefined) clearTimeout(existing)
      const id = window.setTimeout(() => {
        ancestor.classList.remove('scrolled-recently')
        timers.delete(ancestor)
      }, FADE_HOLD_MS)
      timers.set(ancestor, id)
    },
    { capture: true, passive: true },
  )
}
