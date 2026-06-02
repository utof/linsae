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
ytd-app .html5-endscreen { opacity: 0 !important; }
body ytd-app .ytp-chrome-top, body ytd-app .ytp-chrome-bottom, body ytd-app .ytp-gradient-top,
body ytd-app .ytp-show-cards-title, body ytd-app .ytp-watermark, body ytd-app .ytp-pause-overlay {
  opacity: 0 !important; pointer-events: none !important; }
#masthead-ad, ytd-ad-slot-renderer, #player-ads { display: none !important; }
/* Deliberately NOT hiding .video-ads / .ytp-ad-* — Skip-Ad button must stay clickable (spec §4.4). */
`
