import type { Root, Text } from 'mdast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

/**
 * Custom node kind emitted by this plugin. mdast-util-to-hast reads the
 * `data.hName` + `data.hProperties` to lower this into an `<a>` element with
 * the configured className, data-slug, and `linsae://` href.
 *
 * Why custom node type instead of reusing mdast's `link`: keeps wikilinks
 * distinguishable from regular `[text](url)` markdown links (click handler
 * + dangling-class application both gate on the `.wikilink` class).
 */
interface WikilinkNode {
  type: 'wikilink'
  data: { hName: 'a'; hProperties: { className: string[]; 'data-slug': string; href: string } }
  children: [{ type: 'text'; value: string }]
}

/**
 * Remark plugin that rewrites `[[target]]` / `[[target|display]]` /
 * `[[target#section]]` occurrences inside markdown text nodes into anchor
 * nodes carrying `class="wikilink"`, `data-slug="<normalized>"`, and an
 * `href="linsae://note/<slug>"`.
 *
 * Slug normalization matches `src/main/text/slug.ts` `normalizeSlug`
 * (trim + lowercase + collapse internal whitespace to a single space) so the
 * renderer and the main-process link extractor agree on the lookup key.
 *
 * Why a `linsae://` scheme: anchors must carry a valid `href` so the DOM
 * surface stays accessible (keyboard focus / "Copy Link Address"); using a
 * dedicated scheme prevents Electron from navigating away if the click
 * handler ever fails to call `preventDefault()`.
 *
 * Why double-cast `out as unknown as Text[]`: mdast's typed `Parent.children`
 * union has no slot for custom node kinds without ambient module
 * augmentation; the cast is the standard remark-plugin escape hatch.
 *
 * @see src/main/text/wikilinks.ts
 * @see src/main/text/slug.ts
 * @see docs/specs/v0.1-rolling-feed-and-search.md §Wikilinks
 */
export const remarkWikilinks: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index == null) return
    const matches = [...node.value.matchAll(WIKILINK_RE)]
    if (matches.length === 0) return

    const out: Array<Text | WikilinkNode> = []
    let lastEnd = 0
    for (const m of matches) {
      // matchAll on a global regex always sets `index` on each successful match;
      // noUncheckedIndexedAccess can't see that, so fall back to lastEnd defensively.
      const start = m.index ?? lastEnd
      if (start > lastEnd) out.push({ type: 'text', value: node.value.slice(lastEnd, start) })
      // m[1] is the single capture group; matched, so guaranteed non-empty string here.
      const inner = m[1] ?? ''
      const parts = inner.split('|', 2)
      const beforePipe = parts[0] ?? ''
      const afterPipe = parts[1]
      const targetParts = beforePipe.split('#', 2)
      const targetPart = targetParts[0] ?? ''
      const display = (afterPipe ?? targetPart).trim()
      const slug = targetPart.trim().toLowerCase().replace(/\s+/g, ' ')
      // Skip empty-slug wikilinks ([[]], [[ ]], [[#section]], [[|display]])
      // for parity with src/main/text/wikilinks.ts:59. Otherwise the renderer
      // would emit an invisible interactive anchor with empty data-slug that
      // catches focus but can never resolve.
      if (!slug) {
        out.push({ type: 'text', value: node.value.slice(start, start + (m[0] ?? '').length) })
        lastEnd = start + (m[0] ?? '').length
        continue
      }
      out.push({
        type: 'wikilink',
        data: {
          hName: 'a',
          hProperties: {
            className: ['wikilink'],
            'data-slug': slug,
            href: `linsae://note/${encodeURIComponent(slug)}`,
          },
        },
        children: [{ type: 'text', value: display.length > 0 ? display : targetPart.trim() }],
      })
      lastEnd = start + (m[0] ?? '').length
    }
    if (lastEnd < node.value.length) out.push({ type: 'text', value: node.value.slice(lastEnd) })
    parent.children.splice(index, 1, ...(out as unknown as Text[]))
    return index + out.length
  })
}
