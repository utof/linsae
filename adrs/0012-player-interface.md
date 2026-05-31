# 0012 — Player interface with one implementation

## Context
v0.2 embeds YouTube via `youtube-player@5.6.0` (a Promise-wrapped IFrame API
thin wrapper). The schema already has `source_kind TEXT` on `notes`
(`0001_init.sql` line 13) and `video_sources.source_kind TEXT NOT NULL` with a
`CHECK (source_kind IN ('youtube', 'local'))` (`0002_video_threads.sql` line 8).
The `source_kind` seam is therefore real at the data layer: a future local-file
player would simply map to `source_kind = 'local'`.

The research doc (§6.9) recommended defining a `Player` TypeScript interface
now but deferring any `LocalPlayer` stub until there is actual implementation
pressure.

## Decision
A `Player` interface is defined in `src/shared/player.ts` with the following
contract (lines 10–23):

```
load(videoId: string): Promise<void>
play(): Promise<void>
pause(): Promise<void>
seekTo(seconds: number): Promise<void>       // allowSeekAhead = true
getCurrentTime(): Promise<number>
getDuration(): Promise<number | null>        // null until player reports a duration
setPlaybackRate(rate: number): Promise<void>
onStateChange(cb: (s: PlayerState) => void): () => void   // returns unsub fn
destroy(): void
```

The sole implementation is the YouTube singleton in
`src/renderer/src/yt/playerSingleton.ts`. `getPlayer()` constructs a
`YouTubePlayer` instance (from `youtube-player`) on first call with
`host: 'https://www.youtube-nocookie.com'` and `playerVars: { enablejsapi: 1,
controls: 0, rel: 0, playsinline: 1 }` (lines 44–47), wraps it in an object
that satisfies `Player`, and caches it at module scope. The returned `instance`
is typed as `Player & { wrapper: HTMLDivElement; getIframeRect(): DOMRect |
null; videoId: string | null }` — the extra surface is specific to the YouTube
impl (geometry for capture, current video id) and is not in the shared
interface.

`ThreadView` and `TransportBar` receive the `Player` value from `usePlayer`
(`src/renderer/src/yt/usePlayer.ts`), which calls `getPlayer()` and re-parents
`instance.wrapper` into the host ref on mount. All playback calls in those
components go through the `Player` interface methods.

No `LocalPlayer` stub is introduced. If a local-file player ships, it will
implement `Player` and `playerSingleton.ts` will switch on `source_kind`.

## Alternatives
- **No interface — inline `youtube-player` calls at all call sites** — rejected.
  The `source_kind` seam is already in the schema; pretending the boundary does
  not exist at the code layer would require a wider refactor when `local` ships.
  The interface is one 24-line file with zero runtime cost (research §6.9
  "one-page TypeScript contract").
- **Add a `LocalPlayer` stub now** — rejected. Zero implementation pressure;
  a stub would carry `throw new Error('not implemented')` and rot. YAGNI applies
  (research §6.9: "implementation pressure is zero").
- **`WebContentsView` overlay for the player** — considered and rejected as part
  of ADR 0008's alternative analysis. It would have made the `Player` interface
  boundary more complex (capture from a separate `WebContents`) with no benefit
  over the loopback approach.

## Consequences
- The YouTube impl can be swapped for the raw-IFrame fallback (the B1-spike
  technique described in `docs/specs/v0.2-youtube-annotation.md`) by replacing
  the body of `getPlayer()` in one file; `ThreadView`, `TransportBar`, and
  `usePlayer` are unaffected.
- Methods are `Promise`-returning even for semantically synchronous operations
  (`pause`, `destroy`) because the IFrame API queues calls until `onReady` —
  the interface signature must not lie about the async contract.
- `getDuration(): Promise<number | null>` returns `null` when the player has
  not yet reported a duration (the YouTube oEmbed endpoint omits it), so
  `TransportBar` must guard against `null` before rendering a progress bar.

## Sources
- `docs/research/2026-05-30-youtube-player.md` §6.9 — interface-now / stub-
  never rationale.
- `docs/specs/v0.2-youtube-annotation.md` §Player subsystem.
- `src/main/db/migrations/0001_init.sql` line 13 — `source_kind` on `notes`.
- `src/main/db/migrations/0002_video_threads.sql` lines 7–8 — `source_kind`
  CHECK constraint on `video_sources`.
- `youtube-player` npm — https://www.npmjs.com/package/youtube-player
