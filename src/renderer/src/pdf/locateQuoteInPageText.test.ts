// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { locateQuoteInPageText } from './locateQuoteInPageText'

/**
 * A page's text the way `useExcerptCapture` builds it: pdf.js `getTextContent()`
 * items joined with a single space (`useExcerptCapture.ts:102-104`). The first item
 * carries its own trailing space — real pdf.js output routinely does — so the join
 * produces a DOUBLE space at offset 10 and the raw string is genuinely not its own
 * normalized form. Every offset below would be off by one if the map were skipped.
 */
const PAGE_ITEMS = [
  'Third page ',
  'A third page with a longer',
  'paragraph that wraps',
  'across two lines.',
]
const PAGE_TEXT = PAGE_ITEMS.join(' ')
// 'Third page  A third page with a longer paragraph that wraps across two lines.'
//  0         ^10,11 = the double space          38 = the join space      59

/**
 * What `sel.toString()` returns for a drag across two visual lines: the same words,
 * but joined with `\n` where the page text has a space. This exact shape is #189 —
 * `PAGE_TEXT.indexOf(MULTILINE_SELECTION)` is -1.
 */
const MULTILINE_SELECTION = 'A third page with a longer\nparagraph that wraps'

/** The v0.6 fixture, byte-identical to `useExcerptCapture.test.ts:48-51`. */
const V06_PAGE_TEXT = 'before the selected text after'
const V06_QUOTE = 'the selected text'

/**
 * Built from code points, never pasted: an invisible U+00A0 / U+200B sitting in a
 * source string literal is unreviewable and survives a careless reformat.
 */
const NBSP = String.fromCharCode(0x00a0)
const ZWSP = String.fromCharCode(0x200b)
const BOM = String.fromCharCode(0xfeff)

describe('locateQuoteInPageText', () => {
  it('#189: a newline-joined selection matches space-joined page text', () => {
    // The bug itself. The first assertion guards against the fixture silently
    // becoming single-line, which would make the second one vacuous.
    expect(PAGE_TEXT.indexOf(MULTILINE_SELECTION)).toBe(-1)

    expect(locateQuoteInPageText(PAGE_TEXT, MULTILINE_SELECTION)).toEqual({ start: 12, end: 59 })
  })

  it('#189: the returned offsets index the RAW page text, not the normalized one', () => {
    // The whole point of the raw basis (plan §4.2 option B): C2 slices prefix/suffix
    // straight out of `fullText` with these numbers, and already-persisted locators
    // stay comparable. `end` must NOT be `start + selection.length`; the assertions
    // below fail for any off-by-one in either endpoint.
    const range = locateQuoteInPageText(PAGE_TEXT, MULTILINE_SELECTION)
    if (!range) throw new Error('expected a match')

    expect(PAGE_TEXT.slice(range.start, range.end)).toBe(
      'A third page with a longer paragraph that wraps',
    )
    // Exactly what `useExcerptCapture.ts:113-114` computes from these offsets.
    expect(PAGE_TEXT.slice(Math.max(0, range.start - 32), range.start)).toBe('Third page  ')
    expect(PAGE_TEXT.slice(range.end, range.end + 32)).toBe(' across two lines.')
  })

  it('IDENTITY: single-spaced text keeps the v0.6 offsets exactly', () => {
    // The cheapest signal that the offset basis did not move: these are the numbers
    // pinned by the page-1 no-regression test (`useExcerptCapture.test.ts:215-216`)
    // and cited by `adrs/0058-pdf-cross-page-selection-start-anchor.md:120`.
    expect(locateQuoteInPageText(V06_PAGE_TEXT, V06_QUOTE)).toEqual({ start: 7, end: 24 })
  })

  it('trims the selection, so a trailing newline does not shift the range', () => {
    // `sel.toString()` often ends with the line break of the last selected line.
    expect(locateQuoteInPageText(V06_PAGE_TEXT, `${V06_QUOTE}\n`)).toEqual({ start: 7, end: 24 })
    expect(locateQuoteInPageText(V06_PAGE_TEXT, `\n  ${V06_QUOTE} `)).toEqual({ start: 7, end: 24 })
  })

  it('leading and trailing whitespace in the page text does not shift the raw offsets', () => {
    const raw = '\n  Alpha beta gamma  \n'

    expect(locateQuoteInPageText(raw, 'beta')).toEqual({ start: 9, end: 13 })
    expect(raw.slice(9, 13)).toBe('beta')
  })

  it('handles a match at offset 0 and a match at the very end of the page text', () => {
    const raw = 'Alpha beta gamma'

    expect(locateQuoteInPageText(raw, 'Alpha')).toEqual({ start: 0, end: 5 })
    // `end` is exclusive, so the last character's offset + 1 == raw.length.
    expect(locateQuoteInPageText(raw, 'gamma')).toEqual({ start: 11, end: 16 })
    expect(raw.slice(11, 16)).toBe('gamma')
    expect(raw.length).toBe(16)
  })

  it('maps `end` past a collapsed whitespace run inside the match', () => {
    // 'a   b' normalizes to 'a b' (3 chars), so a normalized-basis `end` would be 3
    // and slice back 'a  ' — the run is INSIDE the match, which is where the naive
    // `start + length` arithmetic breaks.
    const raw = 'a   b'

    expect(locateQuoteInPageText(raw, 'a\nb')).toEqual({ start: 0, end: 5 })
    expect(raw.slice(0, 5)).toBe(raw)
    expect(locateQuoteInPageText(raw, 'b')).toEqual({ start: 4, end: 5 })
  })

  it('collapses tabs and newlines in the page text the same as spaces', () => {
    const raw = 'foo\t\n  bar'

    expect(locateQuoteInPageText(raw, 'foo bar')).toEqual({ start: 0, end: 10 })
    expect(raw.slice(0, 10)).toBe(raw)
  })

  it('collapses a non-breaking space, but not a zero-width space', () => {
    // JS `\s` is WhiteSpace + LineTerminator, which INCLUDES U+00A0 (and U+202F,
    // U+2009, U+FEFF, U+3000). It does NOT include U+200B (zero-width space) or
    // U+00AD (soft hyphen) — those stay literal on both sides and must match each
    // other exactly. NBSP reaches this helper from a re-typed or clipboard
    // round-tripped quote rather than from the page text; see the source file on why
    // pdf.js itself cannot deliver one.
    const nbspText = `soft${NBSP}hyphen here`
    expect(locateQuoteInPageText(nbspText, 'soft hyphen')).toEqual({ start: 0, end: 11 })
    expect(nbspText.slice(0, 11)).toBe(`soft${NBSP}hyphen`)

    const zwspText = `zero${ZWSP}width here`
    expect(locateQuoteInPageText(zwspText, 'zero width')).toBeNull()
    expect(locateQuoteInPageText(zwspText, `zero${ZWSP}width`)).toEqual({ start: 0, end: 10 })

    // U+FEFF is the ONLY codepoint that separates `\s` from `\p{White_Space}` (which
    // excludes it), so it is the only assertion that can make a switch between them
    // visible. Without this line the surrounding claim pins nothing: swapping the
    // regex leaves every other case here green. Verified by mutation.
    expect(locateQuoteInPageText(`bom${BOM}split here`, 'bom split')).toEqual({
      start: 0,
      end: 9,
    })
  })

  it('resolves a duplicated quote to its FIRST occurrence', () => {
    // Deliberate: `indexOf` semantics, byte-identical to the v0.6 code this replaces
    // (`useExcerptCapture.ts:112`). Picking a different instance would move the
    // offsets of already-persisted single-line locators, which is exactly what the
    // raw basis exists to preserve. Disambiguating is prefix/suffix's job.
    const raw = 'the cat sat on the mat'

    expect(locateQuoteInPageText(raw, 'the')).toEqual({ start: 0, end: 3 })
    expect(raw.lastIndexOf('the')).toBe(15)
  })

  it('returns null when the quote is not on the page (the cross-page case)', () => {
    // ADR 0058: a cross-page quote genuinely cannot occur in the anchor page's own
    // text. C2's `idx >= 0` guards become `range === null` and still omit all four
    // fields. This must keep working — `useExcerptCapture.ts:109-111`.
    expect(locateQuoteInPageText(PAGE_TEXT, 'text from the next page entirely')).toBeNull()
  })

  it('returns null for an empty page text or an empty selection', () => {
    // `getTextContent()` rejecting mid-selection degrades to '' (`useExcerptCapture.ts:108`).
    expect(locateQuoteInPageText('', V06_QUOTE)).toBeNull()
    // An empty needle would make `indexOf` return 0 and the end-of-match lookup read
    // before the start of the map — null is the only honest answer.
    expect(locateQuoteInPageText(V06_PAGE_TEXT, '')).toBeNull()
    expect(locateQuoteInPageText(V06_PAGE_TEXT, ' \n\t ')).toBeNull()
    expect(locateQuoteInPageText('', '')).toBeNull()
  })
})
