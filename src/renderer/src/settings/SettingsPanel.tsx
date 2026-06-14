/**
 * Settings modal. Opened from the WindowFrame gear (and `⌘,`); closed by the backdrop, the
 * close button, or `Esc` (handled in App alongside the palette's Esc precedence).
 *
 * Deliberately a flat list of sections so it stays simple to extend — v1 ships one section
 * ("YouTube account"). Future sections (search, shortcuts, appearance) append here; the whole
 * panel is expected to be hardened / rebuilt later, so nothing is over-abstracted now.
 *
 * z-index 1000 follows the player-singleton stacking note ("modals/meters ≥ 1000") so the
 * modal paints above the body-pinned player webview (z-index 1) when a thread is open.
 *
 * @see src/renderer/src/topbar/WindowFrame.tsx (gear)
 * @see adrs/0017-youtube-auth-cookie-and-servicelogin.md
 */
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FeedEntrance } from '../feed/entrance/types'
import { setFeedEntrance, useFeedEntrance } from '../lib/anim-pref'
import { api } from '../lib/api'
import { setClock24, useClock24 } from '../lib/clock-pref'
import { useSetSetting, useSetting } from '../lib/use-setting'
import { isYoutubeChromeShown, setYoutubeChrome } from '../yt/playerSingleton'

interface Props {
  open: boolean
  onClose: () => void
}

const btn = {
  border: '1px solid var(--border-0)',
  background: 'var(--bg-2)',
  color: 'var(--fg-1)',
  borderRadius: 4,
  padding: '5px 10px',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  cursor: 'pointer',
} as const

/** YouTube account: sign-in status + sign in / sign out / import cookies + the debug toggle. */
function YoutubeAccountSection() {
  // null = still loading the initial status.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [chromeShown, setChromeShown] = useState(isYoutubeChromeShown())
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = () => {
    void api.youtube.authStatus().then((r) => setSignedIn(r.signedIn))
  }
  // Min 400ms so the "checking…" feedback is always visible — otherwise a fast recheck that
  // returns the same status looks like nothing happened (can't tell loading from bugged).
  const recheck = async () => {
    setChecking(true)
    const [r] = await Promise.all([
      api.youtube.authStatus(),
      new Promise((res) => setTimeout(res, 400)),
    ])
    setSignedIn(r.signedIn)
    setChecking(false)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => refresh(), [])

  const signIn = () => {
    setMsg('opening the sign-in window — sign in there, then click recheck.')
    void api.youtube.signIn()
  }
  const signOut = async () => {
    setBusy(true)
    await api.youtube.signOut()
    setBusy(false)
    setMsg('signed out.')
    refresh()
  }
  const importCookies = async () => {
    setBusy(true)
    const r = await api.youtube.importCookies()
    setBusy(false)
    if (r.canceled) return
    setMsg(`imported ${r.ok} cookies${r.fail ? ` (${r.fail} skipped)` : ''}.`)
    refresh()
  }
  const toggleChrome = () => {
    const next = !chromeShown
    setChromeShown(next)
    setYoutubeChrome(next)
  }

  const status =
    checking || signedIn === null ? 'checking…' : signedIn ? 'signed in' : 'not signed in'
  const dot = !checking && signedIn ? 'var(--accent)' : 'var(--fg-3)'

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
        youtube account
      </h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: '0 0 auto' }}
        />
        <span style={{ color: 'var(--fg-2)' }}>{status}</span>
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          style={{ ...btn, padding: '2px 8px', fontSize: 11 }}
        >
          {checking ? 'checking…' : 'recheck'}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          onClick={signIn}
          style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 0 }}
        >
          sign in…
        </button>
        <button type="button" onClick={signOut} disabled={busy} style={btn}>
          sign out
        </button>
        <button type="button" onClick={importCookies} disabled={busy} style={btn}>
          import cookies from file…
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{msg}</div>}

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--fg-2)',
          cursor: 'pointer',
          marginTop: 4,
        }}
      >
        <input type="checkbox" checked={chromeShown} onChange={toggleChrome} />
        show full youtube ui in the player (debug)
      </label>
      <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: -4 }}>
        un-hides youtube's page chrome so you can see your account / navigate. takes effect on the
        next video load.
      </div>
    </section>
  )
}

/** Display preferences: 12h/24h wall-clock toggle + feed entrance animation picker. */
function DisplaySection() {
  const clock24 = useClock24()
  const entrance = useFeedEntrance()
  const labelStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: 'var(--fg-2)',
    cursor: 'pointer',
  } as const
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>display</h3>
      <label style={labelStyle}>
        <input type="checkbox" checked={clock24} onChange={(e) => setClock24(e.target.checked)} />
        24-hour time
      </label>
      <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: -4 }}>
        show timestamps as 14:23 instead of 2:23 PM (feed + video cards).
      </div>
      <label style={labelStyle}>
        feed entrance
        <select
          aria-label="feed entrance animation"
          value={entrance}
          onChange={(e) => setFeedEntrance(e.target.value as FeedEntrance)}
          style={{ ...btn, padding: '3px 8px' }}
        >
          <option value="glide">glide (slide up)</option>
          <option value="flip">flip (magnet, soft overlap)</option>
          <option value="pbd">pbd (magnet, no overlap)</option>
        </select>
      </label>
      <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: -4 }}>
        how a sent note enters the feed.
      </div>
    </section>
  )
}

/** Search preferences: recent-notes ordering (recent vs frecent). First app_settings consumer. */
function SearchSection() {
  // First consumer of the SQLite app_settings store (spec §8). `useSetting`
  // returns the absence-default ('frecent') until a row exists.
  const mode = useSetting<'recent' | 'frecent'>('notes.recencyMode', 'frecent')
  const set = useSetSetting('notes.recencyMode')
  const labelStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: 'var(--fg-2)',
    cursor: 'pointer',
  } as const
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>search</h3>
      <label style={labelStyle}>
        recent-notes order
        <select
          aria-label="recent-notes order"
          value={mode}
          onChange={(e) => set.mutate(e.target.value)}
          style={{ ...btn, padding: '3px 8px' }}
        >
          <option value="frecent">frecent (frequency + recency)</option>
          <option value="recent">recent (last opened)</option>
        </select>
      </label>
      <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: -4 }}>
        how the recent-notes popover (⌘J) and search empty-state are ordered.
      </div>
    </section>
  )
}

export function SettingsPanel({ open, onClose }: Props) {
  // Reset the transient status message implicitly by remounting the section each open.
  if (!open) return null
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc-to-close is handled centrally in App; backdrop click is a pointer affordance only.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a click-to-dismiss affordance; the keyboard path is Esc (handled in App).
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
    >
      <div
        role="dialog"
        aria-label="settings"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          marginTop: '12vh',
          width: 520,
          maxWidth: '90vw',
          maxHeight: '76vh',
          overflow: 'auto',
          background: '#fff',
          border: '1px solid var(--border-0)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-3)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-0)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)' }}>settings</span>
          <button
            type="button"
            aria-label="close settings"
            onClick={onClose}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--fg-2)',
              cursor: 'pointer',
              display: 'inline-flex',
            }}
          >
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <YoutubeAccountSection />
          <DisplaySection />
          <SearchSection />
        </div>
      </div>
    </div>
  )
}
