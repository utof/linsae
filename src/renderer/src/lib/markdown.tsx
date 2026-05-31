// SPIKE (#4 / lazy-KaTeX): render math imperatively AFTER paint instead of
// synchronously via rehype-katex, so the markdown render (and the morph) isn't
// blocked by KaTeX. Literal $...$ shows first, then upgrades. REVERT if bad.
// @ts-expect-error - katex auto-render contrib has no bundled types
import renderMathInElement from 'katex/contrib/auto-render'
import { type MouseEvent, memo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkWikilinks } from './remark-wikilinks'
import { remarkYtTimestamps } from './remark-yt-timestamps'

interface Props {
  body: string
  onWikilinkClick: (slug: string) => void
  resolveSlug?: (slug: string) => boolean
  /**
   * Called with the timestamp's offset in seconds when the user clicks an
   * `<a class="yt-ts">` anchor emitted by `remarkYtTimestamps`.
   *
   * When omitted the handler falls back to `getPlayer().seekTo(seconds)` so
   * the component works standalone (e.g. in the feed) without requiring a
   * parent to thread the callback down.
   *
   * Why lazy import for the default path: importing `playerSingleton` at
   * module top-level would construct the YouTube IFrame player in any test
   * environment that renders `<Markdown>`, even when `onYtSeek` is supplied.
   * Loading lazily (inside the handler) means the singleton is only touched
   * when the prop is absent AND the user actually clicks — safe in tests.
   *
   * @see src/renderer/src/yt/playerSingleton.ts
   */
  onYtSeek?: (seconds: number) => void
}

/**
 * Renders a markdown `body` with GFM, math (KaTeX), wikilinks, and YouTube
 * timestamp plugins. Wikilinks emit `<a class="wikilink" data-slug="…">`
 * anchors; clicks are intercepted by `onWikilinkClick(slug)` (no navigation).
 * Timestamps emit `<a class="yt-ts" data-seconds="N">` anchors; clicks call
 * `onYtSeek(seconds)` or fall back to `getPlayer().seekTo(seconds)`.
 *
 * When `resolveSlug` is supplied, each rendered wikilink is post-processed to
 * toggle a `.dangling` class + tooltip when `resolveSlug(slug)` returns false,
 * matching spec §Wikilinks resolution rule 4 (orange `--type-question`
 * dangling state).
 *
 * Why a ref-callback (not `useEffect`) for the dangling pass: keeps the
 * `resolveSlug` identity OUT of `ReactMarkdown`'s plugin array — re-running
 * the remark plugins on every parent render would discard the cached mdast/hast
 * tree. The ref-callback runs after the DOM is committed, mutating the
 * already-rendered anchors in place. `body` is in the deps so the pass
 * re-runs when the markdown content changes (new anchors to mark).
 *
 * Why `memo`: a single note bubble's markdown subtree is the most expensive
 * thing the feed renders (parser + KaTeX); upstream `NoteBubble` keys by
 * `(note.id, note.updated_at)` so this `memo` short-circuits all re-renders
 * caused by sibling-bubble scroll.
 *
 * @see src/renderer/src/lib/remark-wikilinks.ts
 * @see src/renderer/src/lib/remark-yt-timestamps.ts
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Markdown rendering
 * @see docs/specs/v0.2-youtube-annotation.md §timestamp syntax
 */
export const Markdown = memo(function Markdown({
  body,
  onWikilinkClick,
  resolveSlug,
  onYtSeek,
}: Props) {
  const handleClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Walk up to the nearest anchor — handles clicks on child elements of <a>.
      const anchor = target.closest('a') as HTMLAnchorElement | null
      if (anchor?.classList.contains('yt-ts')) {
        e.preventDefault()
        const seconds = Number(anchor.dataset.seconds)
        if (onYtSeek) {
          onYtSeek(seconds)
        } else {
          // Lazy import: avoids constructing the YouTube IFrame player in test
          // environments where `onYtSeek` is always supplied. Only reached at
          // runtime when the caller omits the prop (e.g. feed bubbles).
          import('../yt/playerSingleton').then(({ getPlayer }) => {
            getPlayer().seekTo(seconds)
          })
        }
        return
      }
      if (target.classList.contains('wikilink')) {
        e.preventDefault()
        const slug = target.dataset.slug
        if (slug) onWikilinkClick(slug)
      }
    },
    [onWikilinkClick, onYtSeek],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: `body` is depended on so the ref-callback re-fires after ReactMarkdown emits new anchors; keeps `resolveSlug` out of the plugin array to avoid busting the mdast/hast cache.
  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return
      // SPIKE: defer KaTeX to idle so the synchronous render + morph aren't
      // blocked; literal $...$ shows first, then upgrades to rendered math.
      const renderMath = () =>
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        })
      if ('requestIdleCallback' in window) window.requestIdleCallback(renderMath)
      else requestAnimationFrame(renderMath)
      if (!resolveSlug) return
      for (const a of el.querySelectorAll<HTMLAnchorElement>('a.wikilink')) {
        const slug = a.dataset.slug
        if (!slug) continue
        const dangling = !resolveSlug(slug)
        a.classList.toggle('dangling', dangling)
        a.title = dangling ? 'not a note yet — click to start one.' : ''
        a.style.color = dangling ? 'var(--type-question)' : 'var(--accent)'
      }
    },
    [resolveSlug, body],
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click delegated to nested <a class="wikilink"> anchors which are themselves keyboard-focusable; the div carries no semantic role.
    // biome-ignore lint/a11y/useKeyWithClickEvents: anchors handle keyboard activation (Enter dispatches click on focused <a>); no key handler needed on the delegating wrapper.
    <div ref={containerRef} className="markdown-root" onClick={handleClick}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikilinks, remarkYtTimestamps]}>
        {body}
      </ReactMarkdown>
    </div>
  )
})
