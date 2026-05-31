import type { Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { remarkYtTimestamps } from './remark-yt-timestamps'

// ---------------------------------------------------------------------------
// Helpers — build a minimal mdast Root so the test has no dependency on
// remark-parse (which is a transitive dep, not a direct one). The plugin
// only ever walks `text` nodes inside paragraph parents, so this is
// sufficient to cover all behaviour.
// ---------------------------------------------------------------------------

function makeRoot(text: string): Root {
  return {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value: text }],
      },
    ],
  }
}

/** Run the plugin's transformer against a freshly built tree and return the
 *  paragraph's children array after transformation. */
function transform(text: string): Root['children'][number] {
  const tree = makeRoot(text)
  // The plugin is a unified plugin factory; calling it returns the transformer.
  const transformer = (remarkYtTimestamps as () => (tree: Root) => void)()
  transformer(tree)
  // Return the paragraph node so tests can inspect its children.
  const para = tree.children[0]
  if (!para) throw new Error('no paragraph node')
  return para
}

// ---------------------------------------------------------------------------
// Type helper — the nodes emitted by the plugin carry custom `data` that TS
// does not know about (they are cast to `Text[]` internally). Peel them out
// for assertion purposes only.
// ---------------------------------------------------------------------------
interface YtTsNode {
  type: string
  data?: {
    hName?: string
    hProperties?: {
      className?: string[]
      'data-seconds'?: string
    }
  }
  children?: Array<{ type: string; value: string }>
}

function ytTsNodes(para: Root['children'][number]): YtTsNode[] {
  if (para.type !== 'paragraph') return []
  return (para.children as YtTsNode[]).filter(
    (n) => n.data?.hProperties?.['data-seconds'] !== undefined,
  )
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('remarkYtTimestamps — positive matches', () => {
  it('@MM:SS — @1:23 → data-seconds=83', () => {
    const para = transform('see @1:23 for details')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.className).toEqual(['yt-ts'])
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('83')
    expect(nodes[0]?.children?.[0]?.value).toBe('@1:23')
  })

  it('@H:MM:SS — @1:02:33 → data-seconds=3753 (not 62 from @1:02)', () => {
    const para = transform('jump to @1:02:33 now')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('3753')
    expect(nodes[0]?.children?.[0]?.value).toBe('@1:02:33')
  })

  it('@t=MMmSSs — @t=1m23s → data-seconds=83', () => {
    const para = transform('@t=1m23s')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('83')
    expect(nodes[0]?.children?.[0]?.value).toBe('@t=1m23s')
  })

  it('@t=HhMmSs — @t=1h2m3s → data-seconds=3723', () => {
    const para = transform('@t=1h2m3s')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('3723')
    expect(nodes[0]?.children?.[0]?.value).toBe('@t=1h2m3s')
  })

  it('@t= with only seconds — @t=42s → data-seconds=42', () => {
    const para = transform('@t=42s')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('42')
  })

  it('@t= with hours and seconds, no minutes — @t=1h5s → data-seconds=3605', () => {
    const para = transform('@t=1h5s')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('3605')
  })

  it('data.hName is "a"', () => {
    const para = transform('@1:23')
    const nodes = ytTsNodes(para)
    expect(nodes[0]?.data?.hName).toBe('a')
  })

  it('surrounding prose is preserved as sibling text nodes', () => {
    const para = transform('before @1:23 after')
    if (para.type !== 'paragraph') throw new Error('not paragraph')
    const children = para.children as YtTsNode[]
    expect(children).toHaveLength(3)
    expect(children[0]).toMatchObject({ type: 'text' })
    expect((children[0] as unknown as { value: string }).value).toBe('before ')
    // middle is the anchor node
    expect(children[1]?.data?.hProperties?.['data-seconds']).toBe('83')
    expect(children[2]).toMatchObject({ type: 'text' })
    expect((children[2] as unknown as { value: string }).value).toBe(' after')
  })

  it('multiple timestamps in one text node', () => {
    const para = transform('@0:30 intro then @1:00 main')
    const nodes = ytTsNodes(para)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.data?.hProperties?.['data-seconds']).toBe('30')
    expect(nodes[1]?.data?.hProperties?.['data-seconds']).toBe('60')
  })
})

// ---------------------------------------------------------------------------
// Negative / boundary cases — no yt-ts node should be produced
// ---------------------------------------------------------------------------

describe('remarkYtTimestamps — negative / boundary', () => {
  it('email@1pm — word-char before @ is ignored', () => {
    const para = transform('email@1pm')
    expect(ytTsNodes(para)).toHaveLength(0)
  })

  it('email@1:23 — word-char before @ is ignored (boundary guard)', () => {
    const para = transform('email@1:23')
    expect(ytTsNodes(para)).toHaveLength(0)
  })

  it('@99:99 — seconds > 59 do not match', () => {
    const para = transform('@99:99')
    expect(ytTsNodes(para)).toHaveLength(0)
  })

  it('@word — bare @-word without colon or t= does not match', () => {
    const para = transform('@hello @world')
    expect(ytTsNodes(para)).toHaveLength(0)
  })

  it('plain text with no @ tokens is left unchanged', () => {
    const para = transform('nothing special here')
    if (para.type !== 'paragraph') throw new Error('not paragraph')
    const children = para.children as YtTsNode[]
    expect(children).toHaveLength(1)
    expect((children[0] as unknown as { value: string }).value).toBe('nothing special here')
    expect(ytTsNodes(para)).toHaveLength(0)
  })

  it('underscore before @ is also treated as word-char (boundary guard)', () => {
    const para = transform('foo_@1:23')
    expect(ytTsNodes(para)).toHaveLength(0)
  })
})
