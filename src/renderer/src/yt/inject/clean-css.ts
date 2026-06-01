/** Injected via webview.insertCSS to hide chrome (spec §4.4).
 *  Adapted from aidenlx/media-extended (MIT) — web/userscript/youtube.ts getStyle(). */
export const CLEAN_CSS = `
#movie_player:not(.mx-ready), ytd-watch-flexy[theater] #movie_player {
  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  z-index: 2147483647 !important; background: #000 !important; }
html, body { overflow: hidden !important; }
ytd-app .html5-endscreen { opacity: 0 !important; }
body ytd-app .ytp-chrome-top, body ytd-app .ytp-chrome-bottom, body ytd-app .ytp-gradient-top,
body ytd-app .ytp-show-cards-title, body ytd-app .ytp-watermark, body ytd-app .ytp-pause-overlay {
  opacity: 0 !important; pointer-events: none !important; }
#masthead-ad, ytd-ad-slot-renderer, #player-ads { display: none !important; }
/* Deliberately NOT hiding .video-ads / .ytp-ad-* — Skip-Ad button must stay clickable (spec §4.4). */
`
