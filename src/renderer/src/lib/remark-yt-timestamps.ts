import type { Root, Text } from 'mdast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

// ---------------------------------------------------------------------------
// Regexes — ordered longest-first so @1:02:33 is consumed as one token and
// not incorrectly split into @1:02 (MM:SS match) + stray ":33".
//
// Boundary guard: (?<![A-Za-z0-9_]) before each @ ensures that constructs
// like "email@1:23" and "foo_@1:23" are never matched, mirroring the \B@
// intent from docs/specs/v0.2-youtube-annotation.md §timestamp syntax.
//
// Seconds group [0-5]\d enforces 00–59 so @99:99 is never matched.
// ---------------------------------------------------------------------------

/** H:MM:SS — e.g. @1:02:33 → 3753 s */
const HMS_RE = /(?<![A-Za-z0-9_])@(\d{1,2}):([0-5]\d):([0-5]\d)/g

/** MM:SS — e.g. @1:23 → 83 s */
const MS_RE = /(?<![A-Za-z0-9_])@(\d{1,3}):([0-5]\d)/g

/** t= form — e.g. @t=1h2m3s, @t=1m23s, @t=42s, @t=1h5s */
const T_RE = /(?<![A-Za-z0-9_])@t=(?:(\d+)h)?(?:(\d+)m)?(\d+)s/g

// ---------------------------------------------------------------------------
// Custom node emitted by this plugin. mdast-util-to-hast reads `data.hName`
// + `data.hProperties` to lower the node into an `<a class="yt-ts">` element;
// the consumer (E2) delegates click events from that class to a seek handler.
// ---------------------------------------------------------------------------

interface YtTimestampNode {
  type: 'yt-timestamp'
  data: {
    hName: 'a'
    hProperties: { className: ['yt-ts']; 'data-seconds': string }
  }
  children: [{ type: 'text'; value: string }]
}

/**
 * Remark plugin that rewrites `@`-timestamp tokens inside markdown text nodes
 * into anchor nodes rendered as `<a class="yt-ts" data-seconds="N">`.
 *
 * Three token forms are supported (tried longest-first at each position):
 * 1. `@H:MM:SS`  — e.g. `@1:02:33` → 3753 s
 * 2. `@MM:SS`    — e.g. `@1:23` → 83 s
 * 3. `@t=…`      — e.g. `@t=1h2m3s` → 3723 s  (any combo of h/m/s)
 *
 * A word-character boundary guard (`(?<![A-Za-z0-9_])`) before `@` prevents
 * false-positive matches inside email addresses or other compound tokens (e.g.
 * `email@1:23` is ignored). Seconds groups `[0-5]\d` exclude values ≥ 60, so
 * `@99:99` is never matched.
 *
 * Why double-cast `out as unknown as Text[]`: mdast's typed `Parent.children`
 * union has no slot for custom node kinds without ambient module augmentation;
 * the cast is the standard remark-plugin escape hatch — see `remark-wikilinks`
 * for precedent.
 *
 * @see docs/specs/v0.2-youtube-annotation.md §timestamp syntax
 * @see adrs/0011-yt-timestamp-tokens.md
 */
export const remarkYtTimestamps: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index == null) return

    // Collect all timestamp matches across the three forms.  We reset lastIndex
    // on each regex before scanning so that prior calls don't leave stale state.
    HMS_RE.lastIndex = 0
    MS_RE.lastIndex = 0
    T_RE.lastIndex = 0

    interface RawMatch {
      start: number
      end: number
      literal: string
      seconds: number
    }

    const raw: RawMatch[] = []

    // --- H:MM:SS ---
    for (const m of node.value.matchAll(HMS_RE)) {
      const h = Number(m[1] ?? 0)
      const min = Number(m[2] ?? 0)
      const s = Number(m[3] ?? 0)
      const start = m.index ?? 0
      raw.push({ start, end: start + m[0].length, literal: m[0], seconds: h * 3600 + min * 60 + s })
    }

    // --- MM:SS (skip spans already covered by H:MM:SS) ---
    for (const m of node.value.matchAll(MS_RE)) {
      const start = m.index ?? 0
      const end = start + m[0].length
      // Longest-first: if this span overlaps an existing H:MM:SS match, skip.
      if (raw.some((r) => start >= r.start && start < r.end)) continue
      const min = Number(m[1] ?? 0)
      const s = Number(m[2] ?? 0)
      raw.push({ start, end, literal: m[0], seconds: min * 60 + s })
    }

    // --- @t= ---
    for (const m of node.value.matchAll(T_RE)) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (raw.some((r) => start >= r.start && start < r.end)) continue
      const h = Number(m[1] ?? 0)
      const min = Number(m[2] ?? 0)
      const s = Number(m[3] ?? 0)
      raw.push({ start, end, literal: m[0], seconds: h * 3600 + min * 60 + s })
    }

    if (raw.length === 0) return

    // Sort matches by position so we can slice the surrounding text correctly.
    raw.sort((a, b) => a.start - b.start)

    const out: Array<Text | YtTimestampNode> = []
    let lastEnd = 0

    for (const match of raw) {
      if (match.start > lastEnd) {
        out.push({ type: 'text', value: node.value.slice(lastEnd, match.start) })
      }
      out.push({
        type: 'yt-timestamp',
        data: {
          hName: 'a',
          hProperties: {
            className: ['yt-ts'],
            'data-seconds': String(match.seconds),
          },
        },
        children: [{ type: 'text', value: match.literal }],
      })
      lastEnd = match.end
    }

    if (lastEnd < node.value.length) {
      out.push({ type: 'text', value: node.value.slice(lastEnd) })
    }

    parent.children.splice(index, 1, ...(out as unknown as Text[]))
    return index + out.length
  })
}
