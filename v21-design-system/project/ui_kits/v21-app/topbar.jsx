// ============================================================
// v21 — Topbar
// Breadcrumb on the left, search affordance and actions on the right.
// ============================================================

const Topbar = ({ onOpenPalette }) => (
  <header style={{
    height: 'var(--topbar-h)', flex: '0 0 auto',
    borderBottom: '1px solid var(--border-0)',
    background: 'var(--bg-0)',
    display: 'flex', alignItems: 'center', padding: '0 12px',
    gap: 12, position: 'relative', zIndex: 5,
  }}>
    {/* Left — breadcrumb */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-2)', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}>
      <Icon name="panel-left" size={16} style={{ color: 'var(--fg-2)' }} />
      <span style={{ width: 1, height: 16, background: 'var(--border-0)', margin: '0 4px' }}/>
      <span style={{ color: 'var(--fg-2)' }}>daily notes</span>
      <Icon name="chevron-right" size={14} style={{ color: 'var(--fg-3)' }}/>
      <span style={{ color: 'var(--fg-0)', fontWeight: 500 }}>jan 14, 2026</span>
      <span style={{
        marginLeft: 6, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)',
      }}>wed</span>
    </div>

    {/* Center — palette opener (Linear/Tana lineage) */}
    <button
      onClick={onOpenPalette}
      style={{
        appearance: 'none', border: '1px solid var(--border-0)',
        background: 'var(--bg-1)',
        height: 28, padding: '0 10px',
        marginLeft: 'auto', marginRight: 'auto',
        display: 'flex', alignItems: 'center', gap: 8,
        borderRadius: 'var(--r-2)', cursor: 'pointer',
        color: 'var(--fg-2)', fontSize: 13,
        width: 360, minWidth: 0, flexShrink: 1,
        transition: 'background var(--dur-2) var(--ease-out), border-color var(--dur-2) var(--ease-out)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.borderColor = 'var(--border-1)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-1)'; e.currentTarget.style.borderColor = 'var(--border-0)'; }}
    >
      <Icon name="search" size={14}/>
      <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden' }}>search, jump, capture…</span>
      <KBD>⌘</KBD><KBD>K</KBD>
    </button>

    {/* Right — actions */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <IconBtn name="calendar" title="jump to date" />
      <IconBtn name="circle-help" title="open questions" />
      <IconBtn name="bell-off" title="notifications off — by design" />
      <span style={{ width: 1, height: 18, background: 'var(--border-0)', margin: '0 2px' }}/>
      <IconBtn name="panel-right" title="toggle right pane" />
    </div>
  </header>
);

Object.assign(window, { Topbar });
