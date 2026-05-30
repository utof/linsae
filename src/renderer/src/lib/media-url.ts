/**
 * Build the `app://bundle/_media/<…>` URL the renderer uses to display a stored
 * attachment, from the absolute on-disk path returned by the capture IPC. The
 * main process always lays attachments out as `<attachmentsDir>/<yyyy>/<mm>/<sha>.png`
 * (Plan 2 persistCapture), so the last 3 path segments are the stable `_media` tail.
 *
 * Why derive here (vs the main process returning a URL): keeps Plan 2's capture
 * return shape unchanged; the layout is a fixed contract.
 * @see docs/specs/v0.2-youtube-annotation.md §App shell migration (_media routing)
 */
export function mediaUrlFromPath(absPath: string): string {
  const segs = absPath.split(/[/\\]/).filter(Boolean)
  const tail = segs.slice(-3).join('/')
  return `app://bundle/_media/${tail}`
}
