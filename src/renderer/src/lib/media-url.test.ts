import { describe, expect, it } from 'vitest'
import { mediaUrlFromPath } from './media-url'

describe('mediaUrlFromPath', () => {
  it('maps an attachments abs path to its app:// _media URL (last 3 segments)', () => {
    expect(mediaUrlFromPath('/home/u/.config/linsae/attachments/2026/05/deadbeef.png')).toBe(
      'app://bundle/_media/2026/05/deadbeef.png',
    )
  })
  it('handles windows-style separators', () => {
    expect(mediaUrlFromPath('C:\\Users\\u\\AppData\\linsae\\attachments\\2026\\05\\abc.png')).toBe(
      'app://bundle/_media/2026/05/abc.png',
    )
  })
})
