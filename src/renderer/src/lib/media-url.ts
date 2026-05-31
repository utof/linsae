/**
 * Build the relative `/_media/<…>` URL the renderer uses to display a stored
 * attachment, from the absolute on-disk path returned by the capture IPC. The
 * main process always lays attachments out as `<attachmentsDir>/<yyyy>/<mm>/<sha>.png`
 * (Plan 2 persistCapture), so the last 3 path segments are the stable `_media` tail.
 *
 * The URL is relative (`/_media/<tail>`), which is same-origin in both:
 *   - **prod**: the loopback HTTP shell serves `/_media/` from the same origin
 *     as the renderer bundle (both on `http://127.0.0.1:<port>`).
 *   - **dev**: the Vite dev server proxies `/_media/**` to the loopback shell's
 *     fixed `DEV_MEDIA_PORT` (see `electron.vite.config.ts`), keeping it
 *     same-origin from the renderer's perspective.
 *
 * Why derive here (vs the main process returning a URL): keeps Plan 2's capture
 * return shape unchanged; the layout is a fixed contract.
 *
 * @see docs/specs/v0.2-localhost-shell.md §4 L4 + §7 B1
 * @see src/main/http-shell.ts (loopback shell + DEV_MEDIA_PORT)
 */
export function mediaUrlFromPath(absPath: string): string {
  const segs = absPath.split(/[/\\]/).filter(Boolean)
  const tail = segs.slice(-3).join('/')
  return `/_media/${tail}`
}
