/**
 * ThreadView — v21 × YouTube · "1C" timeline-anchored video thread
 * ============================================================================
 * A single video's annotation thread. A video IS a note (Source type); its
 * annotations are ordinary blocks that optionally carry a @timestamp anchor
 * and/or a captured frame. This view sorts those notes two ways.
 *
 * TWO VIEWS, ONE TOGGLE (top-right pill):
 *   • "video time"   → the elastic RAIL (default). Notes ordered by their
 *                      video anchor. THE distinctive view.
 *   • "capture time" → the ordinary v21 chronological feed (wall-clock gutter
 *                      + @video chips). Swapping to it is what reveals WHY a
 *                      timestamp-free note can't sit on the rail.
 *
 * DECISIONS WE AGREED ON (do not silently revert):
 *   ✓ Player is a PLAIN DARK 16:9 RECTANGLE. No play-button overlay, no chrome.
 *   ✓ ONE centered content column. Player, notes, and composer share its left
 *     edge. The time + rail line live in the GUTTER to the LEFT of that column.
 *     (Earlier the notes were wrongly pushed right into the rail's space.)
 *   ✓ NO note-type colors / no Question·Claim·Source labels / no status chips
 *     in the thread. Notes are NEUTRAL. Accent (Figma blue) appears ONLY on
 *     what is CURRENT/active (playhead, the active note, follow, focus).
 *     — Types/status MAY return later; if so the RAIL DOT is the reserved
 *       carrier (hollow/filled/ringed), NOT colored bubbles. Keep it minimal.
 *   ✓ Collapsed dead-air = THREE DOTS centered on the rail; the rail LINE
 *     BREAKS behind them (a mask), it does not run straight through. Gap height
 *     is logarithmic (long skips don't waste space).
 *   ✓ Same-pause cluster = TIGHT STACK under ONE dot, ONE timestamp. NO bracket
 *     ("branch"), NO indent. (We explicitly rejected the bracket.)
 *   ✓ Screenshot notes: the FRAME FILLS THE BUBBLE width at 16:9, caption text
 *     below. (Kills the dead space beside a small thumbnail.)
 *   ✓ "follow" is ONE icon in the player transport. When off and the playhead
 *     scrolls out of view, a "jump to now" PILL appears above the composer.
 *   ✓ Timestamp-free notes ("day 2, watching for…") FLOAT TO THE BOTTOM under a
 *     hairline divider — they never lie about a position on the rail.
 *
 * TOKENS: expects the v21 design-system CSS variables (colors_and_type.css)
 * to be loaded globally. We never hardcode hex except the dark player (#1c1c1e)
 * and the red annotation stroke (#E5484D), which are intentional.
 *
 * NOTE: sample data is trimmed to convey the gist. Real data should come from
 * props/store; see VIDEO_ORDER / CAPTURE_ORDER below for the shape.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, Pause, LocateFixed, Film, Clock,
  Image as ImageIcon, PenTool, PinOff, ArrowDown, CornerDownLeft, Camera,
} from 'lucide-react';

// ── layout constants (the shared column + its left rail gutter) ────────────
const COL = 520;          // shared content column width
const RAIL = -20;         // rail line x, relative to the column's left edge
const DOTC = RAIL + 1;    // visual center of the rail (~-19)

// ── a captured frame: fills its container at 16:9 (decision α) ─────────────
function FrameView({ annotated, label = 'frame' }) {
  return (
    <div style={{
      width: '100%', aspectRatio: '16 / 9', position: 'relative', overflow: 'hidden',
      borderRadius: 'var(--r-3)', background: '#d7d7da', border: '1px solid var(--border-1)',
      backgroundImage: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.035) 0, rgba(0,0,0,0.035) 1px, transparent 1px, transparent 7px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <ImageIcon size={18} color="var(--fg-3)" />
      <span style={{ position: 'absolute', left: 6, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-2)', background: 'rgba(255,255,255,0.72)', padding: '0 4px', borderRadius: 2 }}>{label}</span>
      {annotated && (
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 320 180" preserveAspectRatio="none">
          <path d="M70,96 C110,70 150,120 190,92 S250,70 270,100" fill="none" stroke="#E5484D" strokeWidth={4} strokeLinecap="round" />
        </svg>
      )}
      {annotated && (
        <span style={{ position: 'absolute', top: 6, right: 6, width: 15, height: 15, borderRadius: 3, background: 'var(--fg-0)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <PenTool size={9} strokeWidth={2.4} />
        </span>
      )}
    </div>
  );
}

// ── a neutral note bubble (frame fills the bubble; caption below) ──────────
// `at`    = the VIDEO timestamp anchor (top, accent chip) — what it's about.
// `clock` = the WALL-CLOCK time the note was taken (bottom-right) — our feed
//           convention. NOTE: the left gutter is ONLY for the video-order rail;
//           in the capture/feed view the time lives bottom-right inside the note.
function Note({ body, frame, frameAnn, active, at, maxW, clock }) {
  return (
    <div style={{
      maxWidth: maxW || (frame ? 440 : COL), background: '#fff',
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border-0)'}`,
      borderRadius: 'var(--r-5)', padding: '9px 11px',
      boxShadow: active ? '0 0 0 3px var(--accent-tint)' : 'none',
    }}>
      {at && (
        <div style={{ marginBottom: 6, display: 'inline-flex', alignItems: 'center', gap: 4, height: 18, padding: '0 6px', borderRadius: 'var(--r-1)', background: 'var(--accent-tint)', color: 'var(--accent-press)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{at}</div>
      )}
      {frame && <div style={{ marginBottom: body ? 8 : 0 }}><FrameView annotated={frameAnn} /></div>}
      {body && <div style={{ fontSize: 14, lineHeight: 'var(--lh-normal)', color: 'var(--fg-1)' }}>{body}</div>}
      {clock && <div style={{ marginTop: 4, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)' }}>{clock}</div>}
    </div>
  );
}

// ── rail pieces ────────────────────────────────────────────────────────────
const Time = ({ t, active, top = 11 }) => (
  <span style={{ position: 'absolute', left: -76, top, width: 44, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: active ? 600 : 400, color: active ? 'var(--accent)' : 'var(--fg-3)' }}>{t}</span>
);
const Dot = ({ active, top = 13 }) => (
  <span style={{ position: 'absolute', left: DOTC - 4.5, top, width: 9, height: 9, borderRadius: '50%', background: active ? 'var(--accent)' : 'var(--fg-3)', border: '2px solid var(--bg-0)', zIndex: 2 }} />
);

function Row({ anchor, active, children }) {
  return (
    <div style={{ position: 'relative', marginBottom: 22 }}>
      <Time t={anchor} active={active} />
      <Dot active={active} />
      {children}
    </div>
  );
}

// same-pause cluster: tight stack, one dot, NO bracket (decision A)
function Cluster({ anchor, items }) {
  return (
    <div style={{ position: 'relative', marginBottom: 22 }}>
      <Time t={anchor} />
      <Dot />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it, i) => <Note key={i} {...it} />)}
      </div>
    </div>
  );
}

const gapH = (min) => Math.round(20 + 9 * Math.log(1 + min)); // logarithmic
// collapsed stretch: three dots; the rail line BREAKS behind them (mask)
function Gap({ min }) {
  return (
    <div title={`${min} min skipped — click to expand`} style={{ position: 'relative', height: gapH(min), cursor: 'pointer' }}>
      <span style={{ position: 'absolute', left: RAIL - 3, top: 0, bottom: 0, width: 8, background: 'var(--bg-0)' }} />
      <div style={{ position: 'absolute', left: DOTC - 1.75, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: 'var(--border-2)' }} />)}
      </div>
    </div>
  );
}

const Playhead = React.forwardRef(function Playhead({ at }, ref) {
  return (
    <div ref={ref} style={{ position: 'relative', height: 16, marginBottom: 22 }}>
      <Time t={at} active top={1} />
      <span style={{ position: 'absolute', left: DOTC - 6.5, top: 1, width: 13, height: 13, borderRadius: '50%', background: 'var(--accent)', border: '2px solid #fff', boxShadow: '0 0 0 1.5px var(--accent)', zIndex: 3 }} />
      <span style={{ position: 'absolute', left: -6, right: 0, top: 7, borderTop: '1.5px solid var(--accent)', opacity: 0.35 }} />
    </div>
  );
});

// ── sample data (trimmed — replace with real notes) ────────────────────────
// shape: { anchor, body, frame?, frameAnn?, active?, cluster?: Note[] }
const VIDEO_ORDER = [
  { gap: 6 },
  { anchor: '6:40', body: 'why does the spectral sequence collapse on E₂ for this fibration specifically?' },
  { anchor: '12:48', cluster: [
    { frame: true, frameAnn: true, body: 'the board: E₂ = Hᵖ(B; Hᑫ(F)). circled the d₂ arrow — the whole question.' },
    { body: '…that arrow is d₂ : E₂^{p,q} → E₂^{p+2,q−1}. got it down.' },
  ] },
  { anchor: '13:30', active: true, body: 'collapse at E₂ ⇔ d₂ = 0 and all higher differentials vanish, so E₂ = E_∞.' },
  { playhead: '14:10' },
  { gap: 5 },
  { anchor: '22:40', body: 'is the local-coefficient subtlety load-bearing here, or ignorable for a simply-connected base?' },
];
// notes with NO video anchor — float to the bottom
const THREAD_NOTES = [
  { body: 'day 2 of fibrations. she promised the dimension argument that makes the collapse “obvious” — watching for it.' },
];
// same notes, ordered by WHEN they were written (note 13:30 lands late: rewatch)
const CAPTURE_ORDER = [
  { clock: '09:10', body: 'day 2 of fibrations. watching for the dimension argument.' },
  { clock: '09:12', at: '6:40', body: 'why does the spectral sequence collapse on E₂ for this fibration specifically?' },
  { clock: '09:18', at: '12:48', frame: true, frameAnn: true, body: 'the board: E₂ = Hᵖ(B; Hᑫ(F)). circled the d₂ arrow.' },
  { clock: '09:19', at: '12:48', body: '…that arrow is d₂ : E₂^{p,q} → E₂^{p+2,q−1}.' },
  { clock: '09:27', at: '22:40', body: 'local-coefficient subtlety — load-bearing, or ignorable for a simply-connected base?' },
  { clock: '09:31', at: '13:30', active: true, body: 'collapse ⇔ d₂ = 0 and higher differentials vanish. (figured out on rewatch)' },
];

// ── player: plain dark 16:9 rect + slim transport ─────────────────────────
function Player({ followOn, onToggleFollow }) {
  return (
    <div>
      <div style={{ width: '100%', aspectRatio: '16 / 9', background: '#1c1c1e', borderRadius: 'var(--r-4) var(--r-4) 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderTop: 0, borderRadius: '0 0 var(--r-4) var(--r-4)' }}>
        <Pause size={16} color="var(--fg-1)" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>14:10 / 37:20</span>
        {/* scrubber (decorative here) */}
        <div style={{ position: 'relative', flex: 1, height: 4, borderRadius: 2, background: 'var(--border-1)' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '38%', background: 'var(--accent)', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: 'calc(38% - 6px)', top: -4, width: 12, height: 12, borderRadius: '50%', background: '#fff', border: '2px solid var(--accent)' }} />
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-1)', whiteSpace: 'nowrap', background: 'var(--bg-2)', borderRadius: 'var(--r-1)', padding: '1px 5px' }}>1.5×</span>
        {/* follow = one icon; accent when on */}
        <button onClick={onToggleFollow} title="follow playback in notes" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 'var(--r-2)', border: 0, cursor: 'pointer', background: followOn ? 'var(--accent-tint)' : 'transparent', color: followOn ? 'var(--accent-press)' : 'var(--fg-3)' }}>
          <LocateFixed size={15} />
        </button>
      </div>
    </div>
  );
}

// the one sort affordance — current mode + a mode glyph (NOT a direction arrow)
function SortPill({ sort, onToggle }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
      <button onClick={onToggle} title={`sorted by ${sort === 'video' ? 'position in the video' : 'when captured'} — click to switch`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 27, padding: '0 10px', border: '1px solid var(--border-0)', borderRadius: 'var(--r-pill)', background: 'var(--bg-1)', color: 'var(--fg-1)', fontSize: 12, cursor: 'pointer' }}>
        {sort === 'video' ? <Film size={13} color="var(--fg-2)" /> : <Clock size={13} color="var(--fg-2)" />}
        {sort === 'video' ? 'by video time' : 'by capture time'}
      </button>
    </div>
  );
}

function Composer() {
  return (
    <div style={{ flex: '0 0 auto', borderTop: '1px solid var(--border-0)', padding: '10px 24px 12px', background: 'var(--bg-0)' }}>
      <div style={{ maxWidth: COL, margin: '0 auto', background: '#fff', border: '1px solid var(--border-1)', borderRadius: 'var(--r-4)', boxShadow: 'var(--shadow-2)', padding: '7px 9px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <button title="capture frame ⌘⇧C" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 'var(--r-2)', border: '1px solid var(--border-0)', background: 'var(--bg-1)', color: 'var(--fg-2)', cursor: 'pointer' }}><Camera size={15} /></button>
          <span style={{ display: 'inline-flex', alignItems: 'center', height: 18, padding: '0 6px', borderRadius: 'var(--r-1)', background: 'var(--accent-tint)', color: 'var(--accent-press)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>14:10</span>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-3)' }}>note at this frame…</span>
          <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)', background: 'var(--bg-2)', borderRadius: 'var(--r-1)', padding: '2px 5px' }}>⌘⇧C</kbd>
          <button style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 12px', borderRadius: 'var(--r-2)', border: 0, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>note <CornerDownLeft size={13} /></button>
        </div>
      </div>
    </div>
  );
}

// ── the two thread renderings ──────────────────────────────────────────────
function VideoOrder({ playRef }) {
  return (
    <div style={{ maxWidth: COL, margin: '0 auto', position: 'relative' }}>
      {/* rail line (broken by Gap masks). DECISION: keep the line for now,
          but it's the part most likely to feel like clutter — the "no line"
          option (per-note dots + timestamps only) is the live alternative. */}
      <span style={{ position: 'absolute', left: RAIL, top: 4, bottom: 4, width: 2, background: 'var(--border-1)' }} />
      {VIDEO_ORDER.map((n, i) => {
        if (n.gap) return <Gap key={i} min={n.gap} />;
        if (n.playhead) return <Playhead key={i} at={n.playhead} ref={playRef} />;
        if (n.cluster) return <Cluster key={i} anchor={n.anchor} items={n.cluster} />;
        return <Row key={i} anchor={n.anchor} active={n.active}><Note {...n} /></Row>;
      })}
      {/* timestamp-free notes float to the bottom */}
      <div style={{ marginTop: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--border-0)' }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--fg-3)' }}><PinOff size={11} /> thread notes · no timestamp</span>
          <span style={{ flex: 1, height: 1, background: 'var(--border-0)' }} />
        </div>
        {THREAD_NOTES.map((n, i) => <Note key={i} {...n} />)}
      </div>
    </div>
  );
}

function CaptureOrder() {
  // The ordinary v21 feed: wall-clock time sits BOTTOM-RIGHT inside each note
  // (no left gutter — that's only for the video-order rail). The @video chip
  // (top) still shows which moment the note is about.
  return (
    <div style={{ maxWidth: COL, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {CAPTURE_ORDER.map((n, i) => <Note key={i} {...n} clock={n.clock} />)}
    </div>
  );
}

// ── the view ────────────────────────────────────────────────────────────────
export default function ThreadView() {
  const [sort, setSort] = useState('video');          // 'video' | 'capture'
  const [followOn, setFollowOn] = useState(true);
  const [showPill, setShowPill] = useState(false);
  const threadRef = useRef(null);
  const playRef = useRef(null);
  const toggle = () => setSort((s) => (s === 'video' ? 'capture' : 'video'));

  // pill appears only when NOT following AND the playhead is off-screen
  const checkPill = useCallback(() => {
    if (sort !== 'video' || followOn) return setShowPill(false);
    const c = threadRef.current, p = playRef.current;
    if (!c || !p) return;
    const cr = c.getBoundingClientRect(), pr = p.getBoundingClientRect();
    setShowPill(pr.bottom < cr.top + 8 || pr.top > cr.bottom - 8);
  }, [sort, followOn]);
  useEffect(() => { checkPill(); }, [checkPill]);

  const jumpToNow = () => {
    const c = threadRef.current, p = playRef.current;
    if (c && p) c.scrollTo({ top: p.offsetTop - c.clientHeight / 2, behavior: 'smooth' });
  };

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--bg-0)' }}>
      {/* slim top bar — back + title only (NO global sidebar; app doesn't have one yet) */}
      <header style={{ flex: '0 0 auto', height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--border-0)' }}>
        <ChevronLeft size={17} color="var(--fg-2)" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>lec 9 · fibrations, day 2</div>
          <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>math 232B · 37:20</div>
        </div>
      </header>

      {/* pinned player */}
      <div style={{ flex: '0 0 auto', padding: '14px 24px 12px', borderBottom: '1px solid var(--border-0)' }}>
        <div style={{ maxWidth: COL, margin: '0 auto' }}><Player followOn={followOn} onToggleFollow={() => setFollowOn((v) => !v)} /></div>
      </div>

      {/* thread (scrolls) */}
      <div ref={threadRef} onScroll={checkPill} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 10px', position: 'relative' }}>
        <div style={{ maxWidth: sort === 'video' ? COL : COL + 52, margin: '0 auto' }}>
          <SortPill sort={sort} onToggle={toggle} />
        </div>
        {sort === 'video' ? <VideoOrder playRef={playRef} /> : <CaptureOrder />}
      </div>

      {showPill && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 86, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <button onClick={jumpToNow} style={{ pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg-inverse)', color: 'var(--fg-inverse)', border: 0, fontSize: 12, padding: '6px 12px', borderRadius: 'var(--r-pill)', boxShadow: 'var(--shadow-2)', cursor: 'pointer' }}>
            <ArrowDown size={13} /> jump to now · 14:10
          </button>
        </div>
      )}

      <Composer />
    </div>
  );
}
