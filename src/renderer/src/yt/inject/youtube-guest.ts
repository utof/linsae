/**
 * Returns a self-contained ES2019 JS string that runs INSIDE the youtube.com page.
 * The returned string is injected via webview.executeJavaScript and receives a
 * MessagePort transferred from the host via a nonce-gated window.message event.
 *
 * Wire format matches rpc.ts Wire union exactly:
 *   request:  {t:'invoke', id, method, args}
 *   response: {t:'res', id, ok, value|error}
 *   event:    {t:'event', event, payload}
 *   ready:    {t:'ready'}
 *
 * Adapted from aidenlx/media-extended (MIT) —
 *   web/userscript/youtube.ts, lib/remote-player/{init-port,hook}.
 *
 * Why a string (not a bundled sub-entry): spec §D9 — sidesteps the electron-vite/
 * rolldown "bundle-an-IIFE-and-exclude-from-react-compiler-babel" issue the plan
 * reviewer flagged. The guest code is small, isolated, and covered by the T7 smoke.
 */
export function guestRuntime(nonce: string): string {
  return `(function(NONCE) {
  'use strict';

  /** Inline RPC — wire format must match rpc.ts Wire union exactly. */
  function buildRpc(port) {
    var nextId = 1;
    var pending = {};
    var handlers = {};
    var listeners = {};
    var isDestroyed = false;

    port.onmessage = function(e) {
      var m = e.data;
      if (!m || !m.t) return;
      if (m.t === 'invoke') {
        var fn = handlers[m.method];
        if (!fn) {
          port.postMessage({ t: 'res', id: m.id, ok: false, error: 'no handler: ' + m.method });
          return;
        }
        Promise.resolve().then(function() { return fn.apply(null, m.args || []); }).then(function(val) {
          port.postMessage({ t: 'res', id: m.id, ok: true, value: val });
        }).catch(function(err) {
          port.postMessage({ t: 'res', id: m.id, ok: false, error: String(err) });
        });
      } else if (m.t === 'res') {
        var p = pending[m.id];
        if (!p) return;
        clearTimeout(p.timer);
        delete pending[m.id];
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      } else if (m.t === 'event') {
        var cbs = listeners[m.event];
        if (cbs) { cbs.forEach(function(cb) { cb(m.payload); }); }
      }
    };
    if (port.start) port.start();

    return {
      handle: function(method, fn) { handlers[method] = fn; },
      send: function(event, payload) {
        if (isDestroyed) return;
        port.postMessage({ t: 'event', event: event, payload: payload !== undefined ? payload : null });
      },
      ready: function() {
        if (isDestroyed) return;
        port.postMessage({ t: 'ready' });
      },
      destroy: function() { isDestroyed = true; port.onmessage = null; try { port.close(); } catch(e) {} }
    };
  }

  /** Build flags snapshot from the video element. */
  function flags(v, started, waiting) {
    return {
      ready: true,
      ended: v.ended,
      paused: v.paused,
      waiting: waiting,
      started: started,
      currentTime: v.currentTime,
      duration: isFinite(v.duration) ? v.duration : 0
    };
  }

  var rpc = null;
  var rafId = 0;
  var videoEl = null;
  var startedFlag = false;
  var waitingFlag = false;
  var observerActive = false;

  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function startRaf(v) {
    stopRaf();
    var prevTime = -1;
    function tick() {
      if (!rpc || !v || v.paused || v.ended) { stopRaf(); return; }
      var ct = v.currentTime;
      var dur = isFinite(v.duration) ? v.duration : 0;
      if (ct !== prevTime) {
        prevTime = ct;
        rpc.send('time', { currentTime: ct, duration: dur });
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function attachVideo(v) {
    // Guard against double-attach if re-hook fires while the same <video> is still connected.
    if (v === videoEl) return;
    videoEl = v;
    startedFlag = v.currentTime > 0 || !v.paused;
    waitingFlag = false;

    // Never show the native <video> controls — the app's TransportBar is the only
    // control surface and YouTube's own chrome is hidden by clean-css (audit H).
    try { v.controls = false; } catch(e) { /* read-only in some states */ }

    /** Post state event with current snapshot. */
    function emitState() {
      if (rpc) {
        startedFlag = startedFlag || (!v.paused);
        rpc.send('state', flags(v, startedFlag, waitingFlag));
      }
    }

    var mediaEvents = ['play', 'pause', 'playing', 'waiting', 'canplay', 'seeked', 'durationchange', 'ended', 'loadedmetadata', 'error', 'timeupdate'];
    mediaEvents.forEach(function(evt) {
      v.addEventListener(evt, function() {
        if (evt === 'playing') { startedFlag = true; waitingFlag = false; startRaf(v); }
        if (evt === 'waiting') { waitingFlag = true; }
        if (evt === 'canplay' || evt === 'timeupdate') { waitingFlag = false; }
        if (evt === 'pause' || evt === 'ended') { stopRaf(); }
        emitState();
      });
    });

    // Theater mode: best-effort. The clean-css fill is now UNCONDITIONAL so chrome is
    // hidden regardless, but entering theater nudges YouTube to pick a higher resolution
    // and size the <video> up. (YouTube recreates the button after SPA navigation, so
    // this is best-effort — and we no longer add a .mx-ready class: nothing reads it.)
    try {
      var sizeBtn = document.querySelector('#movie_player .ytp-size-button');
      if (sizeBtn) { sizeBtn.click(); }
    } catch(e) { /* best-effort */ }

    // Initial state event
    emitState();

    // Signal host: chrome hidden, video found
    if (rpc) { rpc.ready(); }

    // If already playing, start RAF
    if (!v.paused) { startRaf(v); }
  }

  /** Poll for the YouTube video element. Retries until found. */
  function findVideo() {
    var v = document.querySelector('ytd-app #movie_player video');
    if (v) { attachVideo(v); return true; }
    return false;
  }

  /** MutationObserver re-hook across SPA navigation. YouTube recreates <video>.
   *  Stays connected for the page lifetime so a second swap is also caught. */
  function setupObserver() {
    if (observerActive) return;
    observerActive = true;
    var target = document.getElementById('movie_player') || document.body;
    var obs = new MutationObserver(function() {
      if (!videoEl || !videoEl.isConnected) {
        videoEl = null;
        waitingFlag = false;
        stopRaf();
        // Do NOT disconnect — keep watching for the next SPA swap.
        findVideo();
      }
    });
    obs.observe(target, { childList: true, subtree: true });
  }

  function initPort(port) {
    rpc = buildRpc(port);

    // Invoke handlers
    rpc.handle('play', function() { if (videoEl) { videoEl.play().catch(function() {}); } return null; });
    rpc.handle('pause', function() { if (videoEl) { videoEl.pause(); } return null; });
    rpc.handle('seekTo', function(s) { if (videoEl) { videoEl.currentTime = s; } return null; });
    rpc.handle('setRate', function(r) { if (videoEl) { videoEl.playbackRate = r; } return null; });
    rpc.handle('setMuted', function(m) { if (videoEl) { videoEl.muted = m; } return null; });

    // Disable YouTube's own keyboard shortcuts — they fight host hotkeys (spec §8)
    // This listener runs in the guest document and does NOT affect the host frame.
    document.addEventListener('keydown', function(e) { e.stopPropagation(); }, true);

    // Track consent/sign-in wall transitions — emit on change, keep observer alive.
    var lastConsentActive = false;
    function checkConsent() {
      var active = !!document.querySelector('ytd-consent-bump-v2-lightbox');
      if (active !== lastConsentActive) {
        lastConsentActive = active;
        rpc.send('needs-interaction', { active: active });
      }
    }

    // Try immediately, then re-check on every DOM mutation for the page lifetime.
    checkConsent();
    var consentObs = new MutationObserver(function() { checkConsent(); });
    consentObs.observe(document.body || document.documentElement, { childList: true, subtree: true });

    // Disable YouTube's "Up Next" autoplay so an ENDED video doesn't swap the <video>
    // to a new src — that would leave the host pointing at the wrong video (notes/seek
    // target the old id). Adapted from media-extended web/userscript/youtube.ts
    // disableAutoPlay: the toggle is a child .ytp-autonav-toggle-button carrying
    // aria-checked; click the wrapping button if it's on. The control lives in the
    // (CSS-hidden) chrome and appears slightly after the video, so poll for it.
    var autoPlayHandled = false;
    function disableAutoPlay() {
      if (autoPlayHandled) return;
      var btn = document.querySelector('button.ytp-button[data-tooltip-target-id="ytp-autonav-toggle-button"]');
      var label = btn && btn.querySelector('.ytp-autonav-toggle-button');
      if (!btn || !label) return;
      autoPlayHandled = true;
      if (label.getAttribute('aria-checked') === 'true') { btn.click(); }
    }
    var apTries = 0;
    var apTimer = setInterval(function() {
      disableAutoPlay();
      if (autoPlayHandled || ++apTries > 100) { clearInterval(apTimer); }
    }, 200);

    // Find or wait for the video
    if (!findVideo()) {
      setupObserver();
      // Poll as fallback in case observer fires too early
      var pollCount = 0;
      var pollTimer = setInterval(function() {
        if (findVideo() || ++pollCount > 100) { clearInterval(pollTimer); }
      }, 200);
    }
  }

  // Receive the transferred MessagePort by nonce
  window.addEventListener('message', function onMsg(e) {
    if (e.data !== NONCE) return;
    window.removeEventListener('message', onMsg);
    initPort(e.ports[0]);
  });

})(${JSON.stringify(nonce)});`
}
