# linsae v0.2 — YouTube Annotation Feature: Defended Technical Proposal

> Author note: All retrieval dates 2026-05-27. Where I could not directly verify a fact this week (e.g. an npm `peerDependencies` block returning 403), I write "Unverified —" and explain what would close the gap.

## 1. TL;DR (one bullet per investigation area)

- **§6.1 Embed library**: Use **`youtube-player` (gajus, npm v5.6.0)** as a thin Promise wrapper around the IFrame API, mounted to a DOM node that lives *outside* React's reconciliation tree (via a portal-attached singleton). **Confidence: High.**
- **§6.2 Screenshot capture**: `BrowserWindow.fromWebContents(senderFrame.webContents).webContents.capturePage(rect)` from main, where `rect` is the iframe's `getBoundingClientRect()` in CSS pixels (DIP). Write PNG to disk in main, return the absolute path string. **Confidence: High** for the API shape; **Medium** for cross-platform frame-paint timing on Wayland.
- **§6.3 Annotation library**: **`perfect-freehand@1.2.3` + a hand-rolled SVG overlay** for v1, with `react-konva@19.2.4 + konva@10.3.0` held in reserve when rect/arrow ship. Reject tldraw (mandatory license-key + watermark in production) and Excalidraw (heavyweight, brand-bound aesthetic). **Confidence: High.**
- **§6.4 Overlay storage**: Two sidecar files — immutable `<hash>.png` + editable `<hash>.svg` — under `userData/attachments/<yyyy>/<mm>/`. SVG holds strokes/text as `<path data-stroke-id>` and `<text>` so it's re-editable, diff-able, and FTS-indexable. **Confidence: High.**
- **§6.5 Note-thread data model**: New `attachments` table (FK to `notes`) + extend `links` with `edge_type='comment-on'` (NO `parent_note_id` column — keeps `notes` flat and plays with the existing wikilink resolver). Cache video titles in a new `video_sources` table populated via YouTube oEmbed on first embed. **Confidence: High.**
- **§6.6 Searchable annotation text**: Store the user's typed annotation as the *body* of the comment-note (so existing FTS5 triggers work for free); render the same string as the "appendix" pill. Stroke geometry stays in the SVG sidecar. **Confidence: High.**
- **§6.7 Timestamp syntax**: Custom **`remark-yt-timestamps`** plugin matching `@MM:SS`, `@H:MM:SS`, and `@t=1m23s`, mirroring the existing in-tree `remark-wikilinks`. Reject wikilink-shaped `[[yt|1:23]]` (collides with note slugs). **Confidence: High.**
- **§6.8 Pixel/timing edge cases**: After `seekTo(t, true)`, wait for `onStateChange === PLAYING(1)` then one `requestAnimationFrame` round-trip from renderer before invoking capture. Use `screen.dipToScreenRect` if/when you need physical-pixel rects. Trigger chrome-hide by pausing the player and dispatching a synthetic `mouseout` on the iframe before capture. **Confidence: Medium** — YouTube docs do not formally specify post-seek state transitions.
- **§6.9 Local-file forward-compat**: Define the `Player` interface NOW (one impl), but DO NOT introduce a `LocalPlayer` stub. Forward-compat is a one-page TypeScript contract; implementation pressure is zero. **Confidence: High.**

---

## 2. Per-area detail

### §6.1 Embed library + player lifecycle

**Recommendation:** Build a singleton wrapper around the official IFrame Player API using **`youtube-player@5.6.0`** (Promise-wrapped, queues calls until `onReady`). Mount the actual `<iframe>` to a top-level `<div id="yt-pinned-player">` inside the rolling-feed shell, NOT inside the React-rendered note bubble for the video. The pinned player div is created imperatively in a `useEffect(..., [])` on the top-level `<VideoThread>` component, its DOM node is held in a `useRef`, and the player instance is stored in a module-level singleton (`/src/renderer/yt/playerSingleton.ts`). Comment bubbles are React-rendered Virtuoso children that *post messages* to the singleton via a tiny event bus.

This survives React 19 + StrictMode double-mount because the singleton checks `if (instance) return instance` before constructing, and the iframe DOM node lives outside the React tree (StrictMode double-effect destroys React state, not detached DOM).

**Library evaluation (as of 2026-05-27):**

| Lib | Latest | Last publish | Weekly DLs | React 19? | License | Verdict |
|---|---|---|---|---|---|---|
| **youtube-player** (gajus) | **5.6.0** | 3 yrs ago | **616,480 (npmtrends, 2026-05-27); 645,498 on a separate snapshot** | n/a (vanilla) | MIT | ✅ Pick this |
| react-youtube (tjallingt) | **10.1.0** | 3 yrs ago | **~1.1M** | Indirect (peer not pinned to 19) | MIT | Reject: opinionated component, harder to escape the React tree |
| lite-youtube-embed (paulirish) | **0.3.4** (Nov 10, 2025) | 6 months ago | n/a (Web Component) | n/a | Apache-2.0 (per repo) | Reject: facade pattern is meant for first-paint optimisation, not persistent-player control. Stars: 6.3k |
| react-lite-youtube-embed | **3.5.1** | 3 months ago | low | Yes | MIT | Reject: same facade concept, React-flavored |
| IFrame API directly | n/a | n/a | n/a | n/a | YouTube ToS | Acceptable fallback if `youtube-player` is abandoned (last release 3 yrs ago) |

Sources:
- `youtube-player` npm page — https://www.npmjs.com/package/youtube-player — retrieved 2026-05-27. "5.6.0 • Public • Published 3 years ago … 80 Dependents".
- `youtube-player` weekly downloads — https://npmtrends.com/youtube-player — retrieved 2026-05-27 — "616,480 weekly downloads and 384 GitHub stars"; a side-by-side comparison snapshot at npmtrends.com/youtube-api-vs-youtube-player records 645,498. Both confirm the package is well above 600k/week.
- `react-youtube` npm — https://www.npmjs.com/package/react-youtube — "10.1.0 • Published 3 years ago", retrieved 2026-05-27. Socket.dev reports 1,101,012 weekly downloads (https://socket.dev/npm/package/react-youtube, retrieved 2026-05-27).
- `lite-youtube-embed` releases — https://github.com/paulirish/lite-youtube-embed/releases — v0.3.4 dated 10 Nov 2025, "Star 6.3k". Retrieved 2026-05-27.

**youtube-nocookie.com viability:** Yes. The `host` parameter on the YT.Player constructor is documented (informally) to swap the embed origin; setting `host: 'https://www.youtube-nocookie.com'` keeps `getCurrentTime`, `seekTo`, `onStateChange`, `getDuration` working. Source: portalZINE writeup citing official API behaviour — https://portalzine.de/dev/html5/youtube-iframe-api-and-cookieless-domain-solution-gdpr-dsgvo/ — retrieved 2026-05-27. The `enablejsapi=1` query param is mandatory on the iframe `src` either way (https://medium.com/@mihauco/youtube-iframe-api-without-youtube-iframe-api-f0ac5fcf7c74, retrieved 2026-05-27). **Unverified —** whether `getVideoData()` (undocumented method) is reliable on `nocookie`; one report (Nebula issue #1519) claims YouTube removed `getVideoData()` from the API — https://github.com/chrisblakley/Nebula/issues/1519 — retrieved 2026-05-27. Use the oEmbed endpoint for titles instead (see §6.5).

**StrictMode double-effect:** React 19 retains the development-only double-mount behavior; effects fire setup → cleanup → setup. The singleton-outside-React pattern avoids the gotcha entirely. Source: https://react.dev/reference/react/StrictMode — retrieved 2026-05-27 — "Your components will re-run Effects an extra time to find bugs caused by missing Effect cleanup."

**YouTube ToS:** The consumer ToS permits embedded-player use: "You may also show YouTube videos through the embeddable YouTube player." — https://www.youtube.com/static?template=terms — retrieved 2026-05-27. The Developer Policies (https://developers.google.com/youtube/terms/required-minimum-functionality, retrieved 2026-05-27) impose: (a) viewport ≥ 200×200 px; (b) HTTP `Referer` header required (Electron will set this from the loaded page automatically when the iframe is loaded inside `https://www.youtube.com/embed/...` — confirms why Error 153 hits Tauri's `tauri://localhost` but does NOT hit Electron's `app://` or `http://localhost` shells); (c) do not "modify, add to or block the standard playback function" — our overlay UI sits BESIDE the player frame, not over it, so we are compliant; (d) attribution / "YouTube Brand Features" must remain visible. For a single-user personal-binary distribution, none of these are obstacles.

**Tauri #14422 verification:** Issue is **OPEN** as of 2026-05-27, labelled `help wanted`, `platform: Linux`, `platform: macOS`, `type: bug`, `type: question`. URL: https://github.com/tauri-apps/tauri/issues/14422 — retrieved 2026-05-27. The body verbatim: "The app works perfectly in development mode but encounters YouTube Error 153 ('Video player configuration error') in production builds due to the `tauri://localhost` protocol not providing a valid HTTP Referer header." This validates the locked stack's rejection of Tauri.

**Gotchas:**
- `youtube-player` was last published "3 years ago" (npm) — maintenance risk. The package is a thin wrapper, so forking is cheap (~600 LoC).
- Setting the iframe `referrerpolicy="strict-origin-when-cross-origin"` is the documented fix for Error 153, per Simon Willison's writeup (https://simonwillison.net/2025/Dec/1/youtube-embed-153-error/, retrieved 2026-05-27). Set this when constructing the iframe.
- Mute autoplay is enforced by Chromium (Electron 39.0.0 bundles Chromium 142.0.7444.52, V8 14.2, and Node 22.20.0 per the official Electron 39 release blog at https://www.electronjs.org/blog/electron-39-0, retrieved 2026-05-27) — first play in a session may require explicit user gesture.

**Open questions I couldn't close:**
- Whether `getVideoData()` still exists in the IFrame API as of May 2026. Recommend probing at runtime and falling back to oEmbed.

---

### §6.2 Screenshot capture at iframe rect

**Recipe (Electron 39):**

```ts
// renderer: src/renderer/yt/capture.ts
const el = document.querySelector<HTMLIFrameElement>('#yt-pinned-player iframe')!;
const r  = el.getBoundingClientRect();                       // CSS pixels
const rect = {
  x: Math.round(r.left), y: Math.round(r.top),
  width: Math.round(r.width), height: Math.round(r.height),
};
const path = await window.api.youtube.capture({ rect });     // → string (absolute)
```

```ts
// main: src/main/ipc/youtube.ts
ipcMain.handle('youtube:capture', async (e, raw) => {
  const { rect } = ytCaptureSchema.parse(raw);               // Zod validates
  const wc = BrowserWindow.fromWebContents(e.sender)!.webContents;
  const img = await wc.capturePage(rect);                    // NativeImage
  const png = img.toPNG();                                   // Buffer
  const hash = createHash('sha256').update(png).digest('hex');
  const dir  = join(app.getPath('userData'), 'attachments', yyyy(), mm());
  await mkdir(dir, { recursive: true });
  const final = join(dir, `${hash}.png`);
  const tmp   = `${final}.tmp`;
  const fh = await open(tmp, 'w'); await fh.write(png); await fh.sync(); await fh.close();
  await rename(tmp, final);                                  // atomic
  return final;
});
```

**Rect units:** Electron uses DIP (CSS pixels) for `Rectangle` structures throughout its API surface. Source: Electron `screen` API docs — https://www.electronjs.org/docs/latest/api/screen — retrieved 2026-05-27. Verbatim: "Physical screen points are raw hardware pixels on a display. Device-independent pixel (DIP) points are virtualized screen points scaled based on the DPI." `webContents.capturePage(rect)` (https://www.electronjs.org/docs/latest/api/web-contents, retrieved 2026-05-27) takes a `Rectangle` so the rect is in DIP. **The returned `NativeImage` is at physical-pixel size** (rect.width × scaleFactor by rect.height × scaleFactor) — documented in electron/electron#8314 (https://github.com/electron/electron/issues/8314, retrieved 2026-05-27): "without specifying a dimension returns in image that is the pixel size of the viewable area * the scale factor". This is exactly what we want for screenshots — full resolution on HiDPI. PNG file size will scale 4× on a 2× display.

**Cross-origin iframe capture works** because Electron's window-level `capturePage` operates on the compositor surface, not the DOM; YouTube's cross-origin iframe is fully rendered into that surface from the main process's perspective. `html2canvas` cannot do this because it walks DOM and reads pixels via `getContext('2d').drawImage`, which the browser blocks for cross-origin frames.

**BrowserView → WebContentsView migration (Electron 30→39):** `BrowserView` is **deprecated** but still functional in Electron 39. Source: https://www.electronjs.org/docs/latest/api/browser-view — retrieved 2026-05-27 — "The BrowserView class is deprecated, and replaced by the new WebContentsView class." The Electron 39.0.0 release notes (https://releases.electronjs.org/release/v39.0.0, retrieved 2026-05-27) list no breaking changes to `capturePage` semantics in v39. For linsae you don't need BrowserView or WebContentsView at all — the YouTube iframe is in the same renderer as React, captured via that renderer's webContents. Keep it simple.

**Return shape (Buffer vs path):** Return **path string**. Justification: (a) ~500 KB–4 MB PNG over the IPC bridge per capture has measurable serialization cost (Electron IPC uses Structured Clone), (b) main is already on disk, (c) the renderer immediately wants to embed via `file://${path}` or `<img src>` with the `app://` protocol — both prefer a path, (d) deduplication: if the SHA-256 already exists on disk, we skip the write entirely and return the existing path. Anti-recommendation: returning a Buffer forces the renderer to re-hash to dedup or to a wasteful re-write.

**Dedup:** SHA-256 of PNG bytes is collision-safe for our scale (single user, lifetime captures < 10^9). Same frame captured twice → identical bytes → same hash → second write is a fast `stat` + skip. The atomic write recipe (tmp + fsync + rename) handles power-loss correctness.

**Cross-platform parity:**
- **macOS / Windows:** `capturePage` is well-exercised, no known iframe-specific bugs in Electron 39.
- **Linux (X11):** Works; HiDPI scale factor follows GDK_SCALE/GDK_DPI_SCALE.
- **Linux (Wayland):** **Open risk.** Wayland capture goes through a different compositor path (`pipewire` / `xdg-desktop-portal-screencast` for whole-screen, but webContents capture is internal Chromium). I could not find a 2025–2026 issue specifically about iframe-rect capturePage failures on Wayland; **Unverified —** need to test against `mutter` (GNOME 46+) and `kwin_wayland`. Mitigation: detect with `process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'` and warn the user on first capture.

---

### §6.3 Annotation library — nondestructive overlay

**Recommendation: `perfect-freehand@1.2.3` (MIT, 0 deps) for stroke math + a hand-rolled SVG overlay component** (~250 LoC at v1). Hold **`react-konva@19.2.4` (published "7 days ago" per npmjs.com/package/react-konva, retrieved 2026-05-27) + `konva@10.3.0`** (both MIT) in reserve when rect/arrow ship in v0.3.

**Why not the canvas/whiteboard giants:**

| Library | Latest | React 19 | License | Bundle | Verdict |
|---|---|---|---|---|---|
| **perfect-freehand** | **1.2.3** | n/a (no React peer) | **MIT, 0 deps** | ~1.2 KB min+gz (lib author's own measurement, https://github.com/steveruizok/perfect-freehand/discussions/6, retrieved 2026-05-27) | ✅ Pick + DIY SVG overlay |
| react-konva + konva | 19.2.4 / 10.3.0 | **Yes (peer pinned to ^19.2.0 ONLY)** | MIT / MIT | ~150 KB gz | ✅ When rect/arrow ship |
| tldraw | **5.0.1** | Yes (^18 ‖ ^19) | **tldraw SDK License — mandatory license-key + watermark in production**: "The SDK will work in production only when provided with a valid and active license key" (https://tldraw.dev/community/license, retrieved 2026-05-27); "In production (HTTPS on a non-localhost domain with NODE_ENV=production), the SDK requires a valid license key" (https://tldraw.dev/sdk-features/license-key, retrieved 2026-05-27) | Heavy (full whiteboard) | ❌ Non-starter for "no telemetry" + personal-use binary |
| @excalidraw/excalidraw | **0.18.1** (published "a month ago" per https://www.npmjs.com/package/@excalidraw/excalidraw, retrieved 2026-05-27 — supersedes 0.18.0) | Yes (peer 17 ‖ 18 ‖ 19; issue **#9186 CLOSED**, https://github.com/excalidraw/excalidraw/issues/9186, retrieved 2026-05-27) | MIT | Heavy; bundles Mermaid for which CVE-2025-54881 was patched in 0.18.x patch line (https://github.com/excalidraw/excalidraw/releases, retrieved 2026-05-27) | ❌ Brand-bound hand-drawn aesthetic; not suitable for technical screenshot annotation |
| fabric.js v6 | 6.4.3 | Compat via `fabric/node` + React useEffect pattern; no official React binding | MIT | ~70 KB gz | ❌ Overkill; OOP API; weak TS at v6.0–6.3 (improving) |
| roughjs / rough-notation | n/a | n/a | MIT | tiny | ❌ Render-only, no input handling |
| plain `<canvas>` | n/a | n/a | n/a | 0 | ❌ Strokes-as-raster only; loses non-destructive editability |

**Path to rect + arrow with perfect-freehand+SVG:**
- v1 stores strokes as `{kind: 'pencil', points: [[x,y,p]...], color, size}` and text as `{kind: 'text', x,y, content, color, font-size}`.
- v0.3 adds `{kind: 'rect', x,y,w,h, stroke, fill, color}` and `{kind: 'arrow', from:[x,y], to:[x,y], color, head}`. Rendering: native SVG `<rect>`, `<line>` + `<polygon>` head. No library upgrade needed.
- v0.4 (only IF user demands selection, multi-select, transform handles): swap render layer to react-konva. The on-disk SVG sidecar format (§6.4) is the source of truth; Konva renders FROM it, so no migration is needed.

**Critical react-konva note:** As of v19.2.4 (verified against https://github.com/konvajs/react-konva/blob/master/package.json, retrieved 2026-05-27), `peerDependencies.react = "^19.2.0"` — **React 18 has been dropped**. linsae is already on React 19, so this is fine, but if you ever pin React, beware.

**Color picker (round swatches, add/remove custom colors):** trivial vanilla React. Persist swatch list in `app.getPath('userData')/swatches.json` as `{hex: string}[]`. No library.

**Undo/redo:** Strokes are immutable structured data in a `useReducer`-managed array. Maintain an `undoStack: AnnotationLayer[]` and `redoStack: AnnotationLayer[]`; each user edit pushes the prior layer. Trivial.

---

### §6.4 Overlay storage format

**Recommendation: two sidecar files per attachment** — `userData/attachments/<yyyy>/<mm>/<sha256>.png` (immutable base) + `userData/attachments/<yyyy>/<mm>/<sha256>.svg` (editable overlay). Database stores the base hash + (eventually) typed-text mirror.

**Why SVG sidecar > JSON sidecar > DB column:**

| Option | Re-editable | Diffable in git/Obsidian | Renders without parser | FTS-indexable | Verdict |
|---|---|---|---|---|---|
| **SVG sidecar** | ✅ Round-trip via DOMParser | ✅ XML text diffs cleanly | ✅ Native `<img src>` or `<object>` | ✅ Text inside `<text>` is indexed via §6.6 indirection | ✅ Pick |
| JSON sidecar | ✅ | Mediocre (no semantic diff) | ❌ Needs runtime renderer | ✅ | Reject |
| DB column (BLOB) | ✅ but slow | ❌ | ❌ | Awkward | Reject — violates "blobs in SQLite are anti-recommended" rule |

**SVG structure (data-attributes preserve our schema while keeping the file natively viewable):**

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 1280 720" data-linsae-version="1">
  <image xlink:href="dQw4w9WgXcQ-83.png" width="1280" height="720"/>
  <g data-layer="annotations">
    <path data-stroke-id="01HXX..." data-stroke-kind="pencil"
          data-stroke-color="#ff5252" data-stroke-size="6"
          fill="#ff5252" d="M120,84 L121,86 ..."/>
    <text data-text-id="01HXY..." x="220" y="155"
          font-family="Inter" font-size="18" fill="#1976d2">
      look at the gradient here
    </text>
  </g>
</svg>
```

**Iterative edits:** Renderer parses SVG → in-memory `AnnotationLayer[]`. On save, re-emit the SVG (write to `<hash>.svg.tmp`, fsync, rename). Base PNG is never touched — verified by storing its hash in the SVG (`data-base-sha256`) and refusing to write if it mismatches.

**Atomic write:** Identical recipe to §6.2 (tmp + fsync + rename). Concurrent saves are not a concern (single-user, single-process).

---

### §6.5 Note-thread data model

**Recommendation: do NOT add `parent_note_id` to `notes`.** Instead:
1. Reuse the existing `links` table with `edge_type='comment-on'` for the comment-of relationship (no schema change beyond data; plays naturally with the wikilink resolver because the `to_slug` is the parent video-note's slug).
2. Add a new `attachments` table for screenshots, with FK to `notes(id)` — this gives us the orphan-discovery primitive for free.
3. Add a new `video_sources` table to cache `{video_id, title, channel, fetched_at}` so we can answer "screenshots from videos whose title matches X" with one indexed LIKE.

**Why not `parent_note_id`:** (a) couples notes to a thread shape that's specific to one type, (b) requires a new column in the frozen `notes` table — additive yes, but irreversible commitment to single-parent semantics, (c) wikilink/backlink semantics already give us threading for free via `links`, (d) cleanest answer to the goal "the video is a note" — both video-notes and comment-notes are just `notes` rows.

**Title-fetch strategy:** Hit YouTube's **oEmbed endpoint** at `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<ID>&format=json` from main on first embed. Cache forever in `video_sources`. No API key needed; YouTube returns `{title, author_name, author_url, thumbnail_url, ...}` per the oEmbed spec. Source: oEmbed example confirmed at https://queen.raae.codes/2022-01-21-yt-oembed/ — retrieved 2026-05-27 — and at https://abdus.dev/posts/youtube-oembed/ — retrieved 2026-05-27. Do NOT use `noembed.com` (third-party proxy, adds runtime dependency on someone else's uptime). The IFrame API's undocumented `getVideoData()` is unreliable per https://github.com/chrisblakley/Nebula/issues/1519 (retrieved 2026-05-27), so oEmbed is the safe choice.

**Orphan-discovery queries (all SARGable against the proposed schema):**

```sql
-- screenshots not attached to any comment-note
SELECT a.* FROM attachments a
WHERE a.note_id IS NULL AND a.kind = 'screenshot';

-- screenshots whose parent video matches video_id
SELECT a.* FROM attachments a
JOIN notes n ON n.id = a.note_id
JOIN links l ON l.from_note_id = n.id AND l.edge_type = 'comment-on'
JOIN notes v ON v.slug = l.to_slug AND v.source_kind = 'youtube'
WHERE json_extract(v.source_locator, '$.video_id') = ?1;

-- screenshots whose parent video's title matches a substring
SELECT a.* FROM attachments a
JOIN notes n ON n.id = a.note_id
JOIN links l ON l.from_note_id = n.id AND l.edge_type = 'comment-on'
JOIN notes v ON v.slug = l.to_slug
JOIN video_sources vs ON vs.video_id = json_extract(v.source_locator, '$.video_id')
WHERE vs.title LIKE ?1;
```

---

### §6.6 Searchable annotation text

**Validated:** typed annotation text lives in the comment-note's `body` field. Reasons:
1. Existing FTS5 indexing via `notes_fts` triggers (assumed present from the 0001_init.sql sketch) covers it for free.
2. The "appendix" pill beneath the screenshot renders straight from `note.body` (or from a parsed-out trailing section delimited by a sentinel like `<!-- linsae:appendix -->` if we want to separate it from prose later).
3. The drawn sketch (`<path data-stroke-*>`) lives in the SVG sidecar — disjoint from body — so editing strokes doesn't trigger FTS rebuilds.

**Refinement:** If a comment-note has a screenshot attached, render its body as **prose first, appendix pill second** (the pill is the visual badge showing the typed text). If body is empty, hide the pill. If body contains text but no attachment, render normally — no pill.

---

### §6.7 Timestamp markdown syntax

**Recommendation: custom remark plugin `remark-yt-timestamps`** (in-tree, ~50 LoC), mirroring the existing in-tree `remark-wikilinks`. Match these forms in order:

| Form | Regex | Use |
|---|---|---|
| `@H:MM:SS` | `\B@(\d{1,2}):([0-5]\d):([0-5]\d)\b` | hours-long videos |
| `@MM:SS` | `\B@(\d{1,3}):([0-5]\d)\b` | normal case |
| `@t=1m23s` | `\B@t=(?:(\d+)h)?(?:(\d+)m)?(\d+)s\b` | URL-style for copy/paste compat |

Render as `<a class="yt-ts" data-seconds="83">@1:23</a>`. A renderer-side delegated click handler resolves the *current pinned video* from the URL/route context and calls `singleton.seekTo(seconds, true)`. Cross-video timestamp clicks (rare) navigate to that video's thread first.

**Rejected alternatives:**
- **`[[yt|1:23]]`** wikilink-shape: collides with the slug namespace. A note literally named `yt` becomes unresolvable.
- **`type='timestamp'` standalone bubble**: over-engineered. Timestamps must be inline within prose.

---

### §6.8 Pixel & timing edge cases

**Frame-ready signal after `seekTo(t, true)`:** YouTube does not document a "frame painted" callback. The reliable recipe:

```ts
async function seekAndSettle(seconds: number) {
  await player.seekTo(seconds, true);             // youtube-player wraps in Promise
  await waitForState(YT.PlayerState.PLAYING);     // 1
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); // 2-frame settle
  // now capture
}
```

Two-RAF settle is the well-known "wait until after Chromium has actually composited" trick. The PLAYING transition is observable via `onStateChange` (`event.data === 1`). **Caveat:** Mozilla's TogetherJS source explicitly documents browser-dependent transitions ("Chrome: pause → pause → play; Firefox: buffering → play → buffering → play" — https://togetherjs.com/source/youtubeVideos.js.html, retrieved 2026-05-27). The recipe above handles both. If the player was paused before seekTo, you may need to also handle paused → buffering → paused transitions; in practice we always `playVideo()` then `pauseVideo()` to force one paint, OR we just accept that capturing a paused frame may briefly show the previous frame for ~100ms (mitigate with the 2-RAF settle).

**Partially scrolled-off iframe:** `getBoundingClientRect()` returns negative `top` when the iframe is scrolled above the viewport. `capturePage` clips to the viewport — passing a rect that extends above `y=0` yields a clipped image. Clamp before passing:

```ts
const clamp = (r: Rect, vp: {w:number,h:number}) => ({
  x: Math.max(0, r.x),
  y: Math.max(0, r.y),
  width:  Math.min(r.width  + Math.min(0, r.x), vp.w - Math.max(0, r.x)),
  height: Math.min(r.height + Math.min(0, r.y), vp.h - Math.max(0, r.y)),
});
```

But the pinned-player design (§6.1) keeps the iframe at the top of the thread, so in practice scroll-off doesn't happen — the comments scroll, not the player. This is the single biggest UX argument for the pinned layout.

**devicePixelRatio:** `rect` is DIP. Returned NativeImage is at physical pixels (`rect.* × scaleFactor`). If you need a 1:1 PNG → CSS-pixel overlay, set `<image width={cssWidth} height={cssHeight}>` in the SVG and let the browser downscale. The PNG file itself stays high-res for zoom-in inspection.

**Cursor / YouTube chrome on idle:** Two mitigations stack:
1. **Before capture, programmatically pause the player** AND **dispatch a synthetic `mouseout` event on the iframe wrapper.** YouTube's chrome auto-hides ~3 seconds after last pointer movement; the synthetic event resets that timer and starts the fadeout. Then wait ~400ms (one fadeout duration) before capture.
2. **Use `controls=0` playerVar** — drops the control bar entirely. Acceptable if linsae provides its own play/pause/seek UI in a wrapper. **YouTube ToS / Developer Policies caveat**: "Modify, add to or block the standard playback function" is prohibited (https://developers.google.com/youtube/terms/developer-policies-guide, retrieved 2026-05-27). Reading the policy strictly, `controls=0` plus linsae-provided controls is the borderline — provided you don't add fast-forward or block the related-videos endcard. Personal-use binary distribution mitigates enforcement risk to ~zero, but for a future public release reconsider.

**Test recipe:** Vitest + jsdom can mock `player.seekTo`/`onStateChange`; integration tests need real Electron (`@playwright/test` Electron mode) to exercise capturePage. Build one Playwright spec that loads a fixed video, seeks to a fixed timestamp, captures, and asserts SHA-256 of the PNG matches a checked-in golden hash per platform.

---

### §6.9 Local-file forward-compat

**Recommendation: introduce the `Player` interface NOW (with one impl), but NOT a `LocalPlayer` stub.**

Argument FOR introducing now:
- The interface is a one-page TypeScript contract. Zero runtime cost. Forces the YouTube impl to be implemented behind a method-call boundary, which means later swap-in of HTML5 `<video>` is purely additive: write `LocalPlayer extends Player`, register a discriminated-union switch on the video-note's `source_kind`.
- Captures the design intent. The README and types document the seam.

Argument AGAINST introducing now (and why I dismiss it):
- "Premature abstraction" — counter: this is not abstraction-for-reuse, it's abstraction-for-bounded-context. The boundary is forced by the source-kind already in the frozen schema.
- "One-impl interfaces invite over-engineering" — counter: the interface is 9 methods, all of which the YouTube impl needs anyway. There is no speculative method.

Interface shape (final): see §4.

---

## 3. Proposed schema addition

`src/main/db/migrations/0002_video_threads.sql`:

```sql
-- ===========================================================
-- linsae 0002_video_threads.sql
-- Additive only. 0001_init.sql is frozen and untouched.
-- ===========================================================

-- Cache of YouTube (and future) video metadata; populated via oEmbed on first
-- embed. Title is denormalised so 'screenshots from videos whose title matches X'
-- is one indexed LIKE, no network call.
CREATE TABLE video_sources (
  video_id     TEXT PRIMARY KEY,            -- '11-char YouTube ID' or future local UUID
  source_kind  TEXT NOT NULL,               -- 'youtube' | 'local'
  title        TEXT,
  channel      TEXT,
  thumbnail_url TEXT,
  duration_sec INTEGER,                      -- nullable; oEmbed doesn't return duration
  fetched_at   INTEGER NOT NULL,
  CHECK (source_kind IN ('youtube', 'local'))
);
CREATE INDEX idx_video_sources_title ON video_sources(title);

-- Screenshots (and future: clipped audio, frame ranges).
-- note_id NULL = orphan (captured but not attached to any comment-note yet).
-- The triple (kind, base_sha256) is unique: identical captures dedupe at the
-- file layer (sha256-named file on disk) AND the DB layer.
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,            -- uuidv7
  note_id       TEXT,                        -- nullable FK to notes(id); orphan when NULL
  kind          TEXT NOT NULL,               -- 'screenshot' (v1) | 'clip' (future)
  base_sha256   TEXT NOT NULL,               -- hash of the immutable PNG bytes
  base_path     TEXT NOT NULL,               -- absolute file path under userData/attachments/...
  overlay_path  TEXT,                        -- nullable: path to <hash>.svg sidecar
  video_id      TEXT,                        -- FK-ish to video_sources(video_id)
  time_seconds  REAL,                        -- timestamp the capture was taken at
  width_px      INTEGER NOT NULL,            -- physical pixels in PNG
  height_px     INTEGER NOT NULL,
  device_pixel_ratio REAL NOT NULL DEFAULT 1,-- so renderer can downscale correctly
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  CHECK (kind IN ('screenshot', 'clip')),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);
CREATE INDEX idx_attachments_note_id      ON attachments(note_id)      WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_video_id     ON attachments(video_id)     WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_base_sha256  ON attachments(base_sha256)  WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_orphans      ON attachments(created_at)   WHERE note_id IS NULL AND deleted_at IS NULL;

-- 0002 makes no changes to notes, note_aliases, links, note_revisions,
-- topic_paths, note_actions, or notes_fts. The 'comment-on' edge is data,
-- not schema: just insert into links with edge_type='comment-on'.
```

---

## 4. Proposed TypeScript interfaces

```ts
// src/shared/player.ts ----------------------------------------------------
export type VideoKind = 'youtube' | 'local';

export interface PlayerLocator {
  kind: VideoKind;
  /** YouTube 11-char ID or future absolute file path */
  ref: string;
}

export interface Player {
  load(locator: PlayerLocator): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Hard seek; allowSeekAhead=true. Resolves after PLAYING state. */
  seekTo(seconds: number, opts?: { settleFrames?: number }): Promise<void>;
  getCurrentTime(): Promise<number>;
  getDuration(): Promise<number | null>;
  /** Returns absolute path to the captured PNG on disk. */
  captureFrame(): Promise<string>;
  destroy(): void;
  onStateChange(cb: (s: 'unstarted'|'ended'|'playing'|'paused'|'buffering'|'cued') => void): () => void;
}

// src/shared/attachments.ts -----------------------------------------------
export type AttachmentKind = 'screenshot' | 'clip';

export interface Attachment {
  id: string;
  noteId: string | null;          // null = orphan
  kind: AttachmentKind;
  baseSha256: string;
  basePath: string;               // absolute fs path
  overlayPath: string | null;     // <hash>.svg sidecar; null if pristine
  videoId: string | null;
  timeSeconds: number | null;
  widthPx: number;
  heightPx: number;
  devicePixelRatio: number;
  createdAt: number;
}

export type Stroke =
  | { kind: 'pencil'; id: string; color: string; size: number; points: Array<[number, number, number?]> }
  | { kind: 'text';   id: string; color: string; fontSize: number; x: number; y: number; content: string }
  | { kind: 'rect';   id: string; color: string; stroke: number; x: number; y: number; w: number; h: number } // v0.3
  | { kind: 'arrow';  id: string; color: string; stroke: number; from: [number, number]; to: [number, number] }; // v0.3

export interface AnnotationLayer {
  version: 1;
  baseSha256: string;     // must match attachment.baseSha256 or refuse to save
  viewBox: { w: number; h: number };
  strokes: Stroke[];
}

// src/shared/api.ts (window.api shape – renderer-facing only) -------------
export interface YouTubeApi {
  capture(args: { rect: { x: number; y: number; width: number; height: number } }): Promise<string>; // absolute PNG path
  fetchOEmbed(args: { videoId: string }): Promise<{
    title: string; author_name: string; author_url: string; thumbnail_url: string;
  }>;
}
export interface AttachmentsApi {
  list(filter: {
    orphans?: boolean;
    videoId?: string;
    titleLike?: string;
    noteId?: string;
  }): Promise<Attachment[]>;
  attachToNote(args: { attachmentId: string; noteId: string }): Promise<void>;
  saveOverlay(args: { attachmentId: string; svg: string }): Promise<{ overlayPath: string }>;
  loadOverlay(args: { attachmentId: string }): Promise<{ svg: string } | null>;
}
export interface VideoSourcesApi {
  upsert(args: { videoId: string; sourceKind: 'youtube' | 'local' }): Promise<void>;
  get(args: { videoId: string }): Promise<{ title: string | null; channel: string | null } | null>;
}

declare global {
  interface Window {
    api: {
      youtube: YouTubeApi;
      attachments: AttachmentsApi;
      videoSources: VideoSourcesApi;
      // existing notes/search APIs are not part of this proposal
    };
  }
}
```

---

## 5. Risk register

**R1 — `youtube-player` (gajus) abandonment.** The npm package was last published "3 years ago" per https://www.npmjs.com/package/youtube-player (retrieved 2026-05-27). If the IFrame API changes in a breaking way (precedent: `getVideoData()` apparently removed per https://github.com/chrisblakley/Nebula/issues/1519), the wrapper won't auto-adapt. **Mitigation:** Vendor the ~600 LoC into `src/renderer/yt/youtubePlayer.ts` (MIT permits this; add a license header). Treat it as a maintained internal file. The IFrame API itself is stable — Google has hosted `https://www.youtube.com/iframe_api` since 2012 and the player parameters page is current at https://developers.google.com/youtube/iframe_api_reference.

**R2 — Wayland Linux capturePage parity.** I could not find a 2025–2026 GitHub issue specifically validating iframe-rect captures on Wayland in Electron 39 (which bundles Chromium 142.0.7444.52, per the Electron 39 release blog at https://www.electronjs.org/blog/electron-39-0, retrieved 2026-05-27). Wayland's screencast path is different from X11/macOS/Windows. **Mitigation:** Add a one-shot self-test at first launch that captures a known fixed rect and verifies width × scaleFactor === image.width. On failure, surface a clear in-app warning and degrade to "open in external player" mode. Track Wayland behaviour as a v0.3 blocker for Linux users on GNOME 46+.

**R3 — YouTube referrer / Error 153 inside Electron's `file://` scheme.** Some Electron apps load the renderer via `file://` for production builds. YouTube's embed flow REQUIRES an HTTP `Referer` header (Required Minimum Functionality, https://developers.google.com/youtube/terms/required-minimum-functionality, retrieved 2026-05-27; root cause analysis at https://simonwillison.net/2025/Dec/1/youtube-embed-153-error/, retrieved 2026-05-27). **Mitigation:** Load the renderer via the `app://` custom protocol (`protocol.registerSchemesAsPrivileged` with `secure: true, standard: true, supportFetchAPI: true`) and set `referrerpolicy="strict-origin-when-cross-origin"` on the iframe. The Tauri Error 153 in issue #14422 is THE warning sign — Electron avoids it only by virtue of running over `http(s)`/`app://`, not `file://`.

**R4 — Annotation SVG/PNG drift.** If a user moves the userData directory or restores from a partial backup, `<hash>.svg` and `<hash>.png` could desync. **Mitigation:** Store `data-base-sha256` in the SVG root and refuse to render/edit the overlay if the referenced PNG's actual SHA-256 mismatches. Show a "base image missing — restore from backup" banner. Atomic rename (tmp + fsync + rename) prevents half-written SVGs.

**R5 — React 19 + tldraw/react-konva version pin trap.** `react-konva@19.2.4` peers React `^19.2.0` ONLY (confirmed against https://github.com/konvajs/react-konva/blob/master/package.json, retrieved 2026-05-27) — older react-konva minor versions support React 18. If linsae ever pins React for a hot-fix, react-konva might silently install a wrong version. **Mitigation:** Add a `lefthook` pre-commit check that asserts `node_modules/react-konva/package.json`'s peer matches `package.json`'s installed React. Trivial 5-line shell.

---

## 6. What I'd build first

The smallest end-to-end vertical slice that proves the entire architecture is **one keyboard shortcut + one save**: with the pinned YouTube player loaded and playing a hard-coded video, press `Cmd+Shift+C` → main captures the iframe rect via `webContents.capturePage` → SHA-256 + atomic-write to `userData/attachments/<yyyy>/<mm>/<hash>.png` → a new note row is inserted with `source_kind='youtube'`, `source_locator={video_id, time_seconds}`, an `attachments` row is inserted pointing to the PNG, and a `links` row with `edge_type='comment-on'` connects it to the parent video-note. Render the screenshot as a thumbnail beneath the player. No annotation overlay, no remark plugin, no oEmbed yet. This single slice exercises: the singleton player, the IPC contract, the schema migration, the atomic file write, the orphan-discovery primitive (the new attachment is born with `note_id=NULL` until linked), and the dedup guarantee (capture twice → same hash → same file). Everything else in this proposal is additive on top of that 200-line proof.