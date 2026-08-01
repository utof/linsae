# 0009 — Screenshot capture pipeline

Status: accepted (v0.2)

## Context
v0.2 lets users capture a still frame of the pinned YouTube player to attach to
a comment-note. The renderer knows only a CSS-pixel `DOMRect` (from
`getBoundingClientRect()` on the player iframe); the actual pixel grab must
happen in the main process because cross-origin iframes are opaque to DOM APIs
(`html2canvas` fails at the canvas-read step for cross-origin content — the
compositor surface is not accessible from the renderer process).

The original research recipe (docs/research/2026-05-30-youtube-player.md §6.2)
confirmed that `webContents.capturePage(rect)` operates on the compositor
surface and therefore works for cross-origin iframes. The returned `NativeImage`
is at physical-pixel resolution (rect × display `scaleFactor`) per
electron/electron#8314.

A zero-area capture edge-case was discovered during implementation: when the
iframe is fully outside the viewport, `clampRect` collapses it to a 0×0
rectangle but `capturePage` resolves normally, writing a degenerate empty PNG
and inserting a junk `attachments` row. GH #34 tracked this.

## Decision
The `youtube:capture` IPC handler in `src/main/ipc/media.ts` (line 44)
captures via `win.webContents.capturePage(rect)`, where:

- `win` = `BrowserWindow.fromWebContents(e.sender)` — the single renderer window.
- `rect` = the renderer's `getBoundingClientRect()` result (CSS px / DIP) after
  passing through `clampRect` (`src/main/media/rect-clamp.ts`), which clamps
  to `win.getContentBounds()` and rounds to integers.
- A 0-area guard (`rect.width === 0 || rect.height === 0`) rejects early and
  throws before calling `capturePage` (GH #34, `media.ts` lines 53–55).

`capturePage` returns a `NativeImage` whose size (`image.getSize()`) is physical
pixels (rect × `screen.getDisplayMatching(win.getBounds()).scaleFactor`).
`persistCapture` (`src/main/media/persist-capture.ts`) then:

1. SHA-256s the PNG bytes via `sha256Hex` (`src/main/media/sha256.ts`).
2. Deduplicates by hash: if `<userData>/attachments/<yyyy>/<mm>/<sha>.png`
   already exists the write is skipped; identical bytes → same file.
3. Writes atomically when new: `tmp` sibling → `writeSync` → `fsyncSync` →
   `renameSync` (`src/main/media/atomic-write.ts`), so a torn write never
   leaves a partial PNG that would later hash-mismatch.
4. Inserts an orphan `attachments` row (`note_id = NULL`; attached to a note
   later via `attachToNote`).

The handler returns `{ id, path, sha256, width, height, devicePixelRatio }`
(the raw PNG `Buffer` is never sent over IPC — see research §6.2 "Return shape"
for the serialisation-cost rationale).

## Alternatives
- **Renderer-side `html2canvas`** — rejected; cannot read cross-origin iframe
  pixels (blocked by the same-origin policy at the canvas level).
- **`screen.dipToScreenRect` for physical-pixel rect** — not used; `capturePage`
  accepts DIP and returns physical pixels automatically. The conversion would add
  complexity with no benefit.
- **Return the PNG Buffer over IPC** — rejected; ~500 KB–4 MB per capture has
  measurable IPC serialisation cost, and the renderer only needs the file path
  (research §6.2 "Return shape").

## Consequences
- Cross-origin YouTube iframe capture works via the compositor surface; no
  special Electron flags are required.
- The physical-pixel ↔ DIP×scaleFactor relationship is confirmed on X11/macOS
  (the hard assert in `scripts/capture-smoke.mjs` line 112 passes). On Linux +
  Wayland the same smoke emits a **warning** instead of failing when
  `result.width !== rect.width × scaleFactor` (`capture-smoke.mjs` lines
  119–131) because the Wayland compositor path is unverified (research §6.2
  "Cross-platform parity"). A mismatch is the signal that this ADR needs a
  source-or-edit.
- Two captures of identical bytes share one PNG file but get distinct
  `attachments` rows (spec §Cardinality B4); the dedup is at the file/
  `base_sha256` layer, not the row layer.

## Sources
- `docs/research/2026-05-30-youtube-player.md` §6.2 — capture recipe and
  cross-platform parity discussion.
- Electron `webContents.capturePage` — https://www.electronjs.org/docs/latest/api/web-contents#contentsCapturePage
- Electron physical-pixel vs DIP — electron/electron#8314 — https://github.com/electron/electron/issues/8314
- GH #34 — 0-area guard: https://github.com/utof/linsae/issues/34
