/**
 * Returns a self-contained ES2019 JS string that runs INSIDE the youtube.com page.
 * The returned string is injected via webview.executeJavaScript and receives a
 * MessagePort transferred from the host via a token-gated window.message event.
 *
 * Wire format matches rpc.ts Wire union exactly:
 *   request:  {t:'invoke', id, method, args}
 *   response: {t:'res', id, ok, value|error}
 *   event:    {t:'event', event, payload}
 *   ready:    {t:'ready'}
 *   ack:      {t:'ack', token}
 *
 * INJECTING IT TWICE INTO ONE DOCUMENT IS A SUPPORTED CALL (contract C5): the host
 * re-injects on every handshake attempt and whenever its C6 watchdog re-enters against
 * a document that is already running this runtime. The second injection only re-arms the
 * expected token through `window.__linsaeGuest.arm(token)`; the receiver installed by the
 * first stays live for the document's lifetime and accepts the new port. Which token the
 * document currently answers to is therefore the LAST one injected — a port transferred
 * with a superseded token is ignored, which is the guest-side half of contract C4.
 *
 * TWO PHASES, and mixing them is the reversal to avoid: per-DOCUMENT wiring (listeners,
 * observers, intervals, the <video> hunt) belongs in `wireDocument()`; per-CHANNEL work (the
 * ack, the invoke handlers) in `initPort()`. Hoisted code reads the CLOSURE `rpc`, which
 * `initPort` repoints. See `adrs/0065-guest-rpc-handshake-rearm.md` D6.
 *
 * Adapted from aidenlx/media-extended (MIT) —
 *   web/userscript/youtube.ts, lib/remote-player/{init-port,hook}.
 *
 * Why a string (not a bundled sub-entry): spec §D9 — sidesteps the electron-vite/
 * rolldown "bundle-an-IIFE-and-exclude-from-react-compiler-babel" issue the plan
 * reviewer flagged. The guest code is small, isolated, and executed for real by
 * `youtube-guest.test.ts` (T9) on top of the T7 smoke.
 *
 * @see docs/specs/v0.8.3-player-transport.md §6.1–§6.5
 * @issue utof/linsae#213
 */
export function guestRuntime(nonce: string): string {
  return `(function(NONCE) {
  'use strict';

  // C5 (spec §6.1). A second copy of this closure would double 11 media-event listeners,
  // a capture-phase keydown stopper, two MutationObservers, three 200ms setIntervals and
  // the rAF loop — the observerActive flag below guards only WITHIN one closure and sees
  // nothing across two injected copies. Re-arm the live one instead and stand down.
  if (window.__linsaeGuest) { window.__linsaeGuest.arm(NONCE); return; }

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
      // Echoes the host's per-attempt token so a late ack from a superseded attempt is
      // dropped rather than publishing a dead channel (contract C4). Distinct from
      // ready(): ack means "transport live", ready means "<video> hooked" (C3).
      ack: function(token) {
        if (isDestroyed) return;
        port.postMessage({ t: 'ack', token: token });
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
  // The token this document currently answers to; replaced by arm() on every re-injection.
  var expectedToken = null;
  // Whether the one-time per-document DOM wiring has been done (C5) — see wireDocument().
  var domWired = false;

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

  function initPort(port, token) {
    // §6.4. The host tears its end of the previous channel down before it re-injects, so an
    // rpc left alive here would keep posting into a port nobody reads. Killing it is also
    // what makes the host's rule "a superseded attempt stands down silently" load-bearing:
    // a retry of an attempt the host already published would destroy the live peer.
    if (rpc) { rpc.destroy(); rpc = null; }
    rpc = buildRpc(port);

    // §6.3 / C3: the FIRST act, ahead of every DOM touch below. 'ack' means only "the
    // transport is live" — which is why it fires on a consent page that has no <video> at
    // all — where 'ready' (sent from attachVideo) means "<video> hooked". The host publishes
    // the channel on ack and drops its cover on ready; neither may be inferred from the other.
    rpc.ack(token);

    // Invoke handlers
    rpc.handle('play', function() { if (videoEl) { videoEl.play().catch(function() {}); } return null; });
    rpc.handle('pause', function() { if (videoEl) { videoEl.pause(); } return null; });
    rpc.handle('seekTo', function(s) {
      // Seek via YouTube's player API seekTo(seconds, allowSeekAhead=true) — allowSeekAhead
      // requests media OUTSIDE the buffered range (a raw video.currentTime= set does not).
      // #movie_player exposes the same API object as the IFrame embed. Far/unbuffered seeks
      // need an authenticated session to deliver the out-of-buffer segment (SABR/PoToken —
      // ADR 0017); the buffering UI for that stall is tracked separately (loading spinner).
      var mp = document.getElementById('movie_player');
      if (mp && typeof mp.seekTo === 'function') { mp.seekTo(s, true); }
      else if (videoEl) { videoEl.currentTime = s; }
      return null;
    });
    rpc.handle('setRate', function(r) { if (videoEl) { videoEl.playbackRate = r; } return null; });
    rpc.handle('setMuted', function(m) { if (videoEl) { videoEl.muted = m; } return null; });

    wireDocument();
  }

  /**
   * The one-time, per-DOCUMENT wiring: everything below outlives any single channel and is
   * re-entered on every re-arm, so it must no-op the second time (C5). None of it needs
   * rebuilding for a new channel — each site reads the CLOSURE variable 'rpc', which
   * initPort has just repointed at the new one, so a re-armed host receives their events
   * without a second copy of the listener/observer/interval that produces them.
   */
  function wireDocument() {
    if (domWired) return;
    domWired = true;

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

    // Force-unmute on load. YouTube persists volume/mute in localStorage; an autoplay-blocked
    // session (our autoplayPolicy=user-gesture-required) makes its player save muted:true, and
    // with the chrome hidden there's no volume control to undo it — so every later video loads
    // silent. Unmuting the (paused) player is always allowed and re-saves muted:false, so audio
    // is restored for both native click-to-play and the host play button. Volume UI is #63.
    var unmuted = false;
    function forceUnmute() {
      if (unmuted) return;
      var mp = document.getElementById('movie_player');
      if (!mp || typeof mp.unMute !== 'function') return;
      unmuted = true;
      try {
        mp.unMute();
        if (typeof mp.getVolume === 'function' && mp.getVolume() === 0 && mp.setVolume) { mp.setVolume(100); }
      } catch(e) { /* player API not ready yet */ }
    }
    var umTries = 0;
    var umTimer = setInterval(function() {
      forceUnmute();
      if (unmuted || ++umTries > 100) { clearInterval(umTimer); }
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

  /** Point this document at a new handshake token (spec §6.2). */
  function arm(token) {
    expectedToken = token;
  }

  // Receive the transferred MessagePort by token. The listener stays installed for the
  // DOCUMENT's lifetime: removing itself on the first match (as it did before C5) meant the
  // second port a re-armed handshake transferred was dropped unacked, so the host retried
  // until it gave up and the player went silently dead on a document that was still alive.
  //
  // Deliberately NO 'event.source === window' check. Electron's recipe assumes the message
  // originates from a preload in the SAME window; ours arrives from the host frame via
  // contentWindow.postMessage, so e.source is not window — what it actually is under
  // Electron 42's inner-WebContents model is unverified, and copying the check could break
  // the receiver outright (spec §6.2).
  window.addEventListener('message', function(e) {
    if (e.data !== expectedToken) return;
    // A token-shaped message carrying no transferred port must not reach initPort: it would
    // destroy the LIVE rpc and then throw on an undefined port, killing a working channel.
    if (!e.ports || e.ports.length !== 1) return;
    initPort(e.ports[0], e.data);
  });

  // Published LAST, so a throw anywhere above cannot leave a sentinel that turns every later
  // injection into a no-op arm() on a runtime that never finished starting.
  window.__linsaeGuest = { arm: arm };
  arm(NONCE);

})(${JSON.stringify(nonce)});`
}
