/**
 * Where a selected quote sits inside a PDF page's text — matched on a
 * whitespace-insensitive basis, but reported in RAW offsets.
 *
 * Why the two bases: `useExcerptCapture` builds the page text by joining pdf.js
 * `getTextContent()` items with a space, while `sel.toString()` joins visual lines
 * with `\n`. A bare `indexOf` therefore misses every multi-line selection and the
 * capture silently drops prefix / suffix / textStart / textEnd (#189). Normalizing
 * fixes the match; reporting NORMALIZED offsets would break something else — every
 * already-persisted locator indexes the raw join, and collapsing a whitespace run
 * earlier in the page shifts them, leaving two silently-mixed bases in stored data
 * with no version marker. So: normalize to match, map back to raw to report.
 *
 * @issue utof/linsae#189
 * @see adrs/0058-pdf-cross-page-selection-start-anchor.md — the `null` case (a
 * cross-page quote genuinely is not in the anchor page's text) stays honest degradation.
 */

/**
 * Every character JS counts as whitespace: WhiteSpace + LineTerminator. That
 * INCLUDES U+00A0 (nbsp), U+202F, U+2009 and U+FEFF — which matters, because pdf.js
 * emits those in real text content and a re-typed quote carries a plain space. It
 * EXCLUDES U+200B (zero-width space) and U+00AD (soft hyphen): those stay literal on
 * both sides and must match each other exactly.
 * No `g` flag — a global regex carries `lastIndex` across `.test()` calls.
 */
const WHITESPACE = /\s/

/** A whitespace-collapsed string, paired with where each of its characters came from. */
interface NormalizedText {
  /** Each `/\s+/` run of the source replaced by exactly one `' '`. */
  text: string
  /** `srcIndex[i]` is the offset, in the SOURCE string, of `text[i]`. */
  srcIndex: number[]
}

/**
 * Collapse whitespace runs while recording each surviving character's source offset.
 * Leading/trailing whitespace is collapsed but not stripped, so the map stays a
 * straight parallel array; the quote is trimmed instead, which is what makes the
 * ends line up.
 */
function normalize(source: string): NormalizedText {
  let text = ''
  const srcIndex: number[] = []
  let inRun = false
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i)
    if (WHITESPACE.test(ch)) {
      // Only the FIRST character of a run is kept, so `srcIndex` points at the run's
      // start — which is what makes `start` land on the raw text the user selected.
      if (inRun) continue
      inRun = true
      text += ' '
    } else {
      inRun = false
      text += ch
    }
    srcIndex.push(i)
  }
  return { text, srcIndex }
}

/** A half-open `[start, end)` character range in the RAW page text. */
interface RawTextRange {
  start: number
  end: number
}

/**
 * Find `quote` in `pageText` ignoring how whitespace is spelled, and return the
 * matching range as offsets into the RAW `pageText` — ready to slice prefix/suffix
 * out of it and to store as `textStart`/`textEnd`.
 *
 * `end` is NOT `start + quote.length`: the raw quote carries `\n` where the page has
 * a space, and a collapsed run inside the match makes the raw span longer than the
 * normalized one. Both ends go through the map.
 *
 * The quote is trimmed (a selection usually ends on the line break of its last line),
 * so the range covers the trimmed text even though the caller stores the raw quote.
 *
 * Returns `null` when there is no match — including the empty/whitespace-only quote,
 * which `indexOf` would otherwise report as a spurious match at 0. Callers keep the
 * v0.6 behaviour of omitting all four text fields in that case.
 *
 * A quote occurring more than once resolves to its FIRST occurrence: `indexOf`
 * semantics, identical to the v0.6 code this replaces, so offsets already persisted
 * for single-line locators stay comparable. Disambiguating is prefix/suffix's job.
 *
 * @issue utof/linsae#189
 */
export function locateQuoteInPageText(pageText: string, quote: string): RawTextRange | null {
  const needle = normalize(quote).text.trim()
  if (needle === '') return null
  const page = normalize(pageText)
  const idx = page.text.indexOf(needle)
  if (idx < 0) return null
  // Both lookups are provably in range — `indexOf` found `needle.length >= 1`
  // characters at `idx`, and `srcIndex` is exactly as long as `page.text` — so the
  // assertions only silence `noUncheckedIndexedAccess`, they hide no branch.
  const start = page.srcIndex[idx]!
  const lastChar = page.srcIndex[idx + needle.length - 1]!
  return { start, end: lastChar + 1 }
}
