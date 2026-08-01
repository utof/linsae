# 0011 — @-prefixed timestamp syntax

Status: accepted (v0.2)

## Context
v0.2 allows comment-notes to contain inline timestamp references (e.g. `@1:23`)
that seek the pinned player when clicked. A syntax must be chosen that (a)
embeds naturally in markdown prose, (b) is unambiguous (no collision with
existing syntax), and (c) is parseable by a remark plugin so the existing
`react-markdown` + `ReactMarkdown` rendering pipeline handles it without a
separate preprocessor pass.

The repo already has an in-tree `remark-wikilinks` plugin as a model; the
research doc (§6.7) confirmed the same pattern works for timestamps and
identified two rejected alternatives.

## Decision
A custom `remarkYtTimestamps` plugin
(`src/renderer/src/lib/remark-yt-timestamps.ts`) is added to the remark
pipeline alongside `remarkWikilinks`. It visits `text` nodes and rewrites three
token forms (tried longest-first to avoid partial-match ambiguity):

1. `@H:MM:SS` — e.g. `@1:02:33` → 3753 s  
   regex: `(?<![A-Za-z0-9_])@(\d{1,2}):([0-5]\d):([0-5]\d)`
2. `@MM:SS` — e.g. `@1:23` → 83 s  
   regex: `(?<![A-Za-z0-9_])@(\d{1,3}):([0-5]\d)`
3. `@t=…` — e.g. `@t=1h2m3s` → 3723 s (any combo of h/m/s)  
   regex: `(?<![A-Za-z0-9_])@t=(?:(\d+)h)?(?:(\d+)m)?(\d+)s`

The `(?<![A-Za-z0-9_])` lookbehind prevents matching inside email addresses or
compound tokens such as `email@1:23`. Seconds groups `[0-5]\d` reject values
≥ 60 so `@99:99` is never matched (plugin lines 17–23).

Each matched token is emitted as a custom `yt-timestamp` mdast node that
`mdast-util-to-hast` lowers to `<a class="yt-ts" data-seconds="N">` via
`data.hName` + `data.hProperties` (plugin lines 31–38).

The click handler lives in `src/renderer/src/lib/markdown.tsx` as a delegated
listener on the `.markdown-root` wrapper (lines 67–86). When the target anchor
has class `yt-ts`, it calls `onYtSeek(seconds)` if that prop is supplied
(ThreadView passes it down), or lazily imports `playerSingleton.getPlayer()`
otherwise (for feed bubbles where the prop is absent). The seek is a secondary
reference: it moves the pinned player but does NOT change the note's
`source_locator` anchor.

`remarkYtTimestamps` is registered in `ReactMarkdown`'s `remarkPlugins` array
in `markdown.tsx` (line 117), after `remarkWikilinks`.

## Alternatives
- **`[[yt|1:23]]` wikilink-shape** — rejected. Collides with the slug
  namespace: a note literally named `yt` becomes unresolvable through the
  wikilink resolver (research §6.7, confirmed in the plugin's own JSDoc).
- **Standalone `type='timestamp'` bubble** — rejected. Timestamps are
  semantically inline in prose; promoting them to a bubble type would require
  a new note type, new rendering path, and prevents mixed prose+timestamp in
  one comment-note body (research §6.7).

## Consequences
- The three regex forms are ordered and overlap-checked at parse time
  (`remark-yt-timestamps.ts` lines 92–110): H:MM:SS matches are registered
  first, then MM:SS skips spans already covered by an H:MM:SS match.
- The `yt-timestamp` custom node type is not in mdast's official union; the
  `parent.children.splice(…, out as unknown as Text[])` double-cast (line 142)
  is the standard remark plugin escape hatch, following the pattern in
  `remark-wikilinks`.
- Timestamps inside code blocks and inline code are safe: `visit(tree, 'text',
  …)` only visits plain-text nodes; code-block children have type `'code'` or
  `'inlineCode'` and are never visited.

## Sources
- `docs/research/2026-05-30-youtube-player.md` §6.7 — timestamp syntax
  rationale and rejected alternatives.
- `docs/specs/v0.2-youtube-annotation.md` §timestamp syntax.
- `src/renderer/src/lib/remark-wikilinks.ts` — precedent for the custom mdast
  node + double-cast pattern.
