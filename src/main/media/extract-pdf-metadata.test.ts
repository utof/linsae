// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractPdfMetadata } from './extract-pdf-metadata'

const FIXTURE = join(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'tiny.pdf',
)

describe('extractPdfMetadata', () => {
  it('reads page count from a real PDF', async () => {
    const bytes = readFileSync(FIXTURE)
    const meta = await extractPdfMetadata(bytes)
    expect(meta.pageCount).toBe(1)
    // title may be null for a minimal fixture
    expect(meta.title === null || typeof meta.title === 'string').toBe(true)
  })
})
