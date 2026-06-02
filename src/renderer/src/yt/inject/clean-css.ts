/** Injected via webview.insertCSS to hide chrome (spec §4.4).
 *  Adapted from aidenlx/media-extended (MIT) — web/userscript/youtube.ts getStyle().
 *
 *  The #movie_player fill is UNCONDITIONAL: position:fixed + inset:0 + a maxed z-index
 *  pin the player over the whole webview viewport, COVERING the masthead, the "up next"
 *  sidebar and the description so only the video shows — including when the player pane
 *  is expanded to fill the app (in-app fullscreen). It was previously gated on
 *  `:not(.mx-ready)` + `ytd-watch-flexy[theater]`; the guest adds `.mx-ready` the moment
 *  it hooks the <video>, which switched the fill OFF and let the rest of the YouTube page
 *  show through. object-fit:contain letterboxes the <video> to fill the player without
 *  relying on YouTube's own resize, and (YouTube's inline width/height carry no
 *  !important) wins the cascade. */
export const CLEAN_CSS = `
#movie_player {
  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  z-index: 2147483647 !important; background: #000 !important; }
#movie_player .html5-video-container { width: 100% !important; height: 100% !important; }
#movie_player video {
  width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important;
  object-fit: contain !important; }
html, body { overflow: hidden !important; }
/* Hide EVERY player overlay — chrome bars, gradients, title, end cards, the fullscreen
   engagement/like-share/QR overlay, the "more" chevron, the cued thumbnail, watermark —
   with a whitelist instead of enumerating .ytp-* classes. This keeps new/renamed YouTube
   overlays hidden and survives YouTube reparenting the player when it enters its own
   (native) fullscreen, which leaked those overlays before. Keep ONLY the <video> and the
   ad module (the Skip-Ad button must stay clickable, spec §4.4); opacity:0 (not
   display:none) so YouTube's player JS still sees the controls it measures. */
#movie_player > *:not(.html5-video-container):not(.video-ads) {
  opacity: 0 !important; pointer-events: none !important; }
#masthead-ad, ytd-ad-slot-renderer, #player-ads { display: none !important; }
`
