// ============================================================
// v21 — Left sidebar
// Today / pinned / saved searches / supertag explorer.
// Not a folder tree.
// ============================================================

const SidebarItem = ({ icon, label, count, active, accent, onClick, indent = 0 }) => (
  <button
    onClick={onClick}
    style={{
      width: '100%', border: 0, cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 8,
      padding: `0 10px 0 ${10 + indent * 14}px`,
      height: 28,
      borderRadius: 'var(--r-2)',
      background: active ? 'var(--bg-3)' : 'transparent',
      color: active ? 'var(--fg-0)' : 'var(--fg-1)',
      fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: active ? 500 : 400,
      textAlign: 'left',
      transition: 'background var(--dur-2) var(--ease-out)',
      position: 'relative',
    }}
    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-2)'; }}
    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
  >
    {active && (
      <span style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 2, borderRadius: 1, background: 'var(--accent)' }}/>
    )}
    {icon && (
      <span style={{ width: 16, display: 'inline-flex', color: accent || (active ? 'var(--fg-0)' : 'var(--fg-2)') }}>
        <Icon name={icon} size={14} />
      </span>
    )}
    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    {count != null && (
      <span style={{
        fontSize: 11, fontFamily: 'var(--font-mono)',
        color: 'var(--fg-2)', minWidth: 18, textAlign: 'right',
      }}>
        {count}
      </span>
    )}
  </button>
);

const SidebarHeading = ({ children, action }) => (
  <div style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 10px 4px 10px',
  }}>
    <span style={{
      fontSize: 11, letterSpacing: 'var(--tracking-mega)', textTransform: 'uppercase',
      color: 'var(--fg-2)', fontWeight: 500,
    }}>{children}</span>
    {action && <span style={{ color: 'var(--fg-3)', cursor: 'pointer' }}><Icon name={action} size={12}/></span>}
  </div>
);

const Sidebar = ({ active, onSelect }) => (
  <aside style={{
    width: 'var(--sidebar-w)', flex: '0 0 auto',
    background: 'var(--bg-1)', borderRight: '1px solid var(--border-0)',
    display: 'flex', flexDirection: 'column',
    height: '100%',
  }}>
    {/* Workspace header */}
    <div style={{
      height: 'var(--topbar-h)', padding: '0 10px',
      display: 'flex', alignItems: 'center', gap: 8,
      borderBottom: '1px solid var(--border-0)',
    }}>
      <img src="../../assets/logo-mark.svg" width="22" height="22" alt="v21" style={{ borderRadius: 5 }}/>
      <span style={{ fontWeight: 600, fontSize: 14 }}>personal</span>
      <span style={{ color: 'var(--fg-3)', fontSize: 12, marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>v21</span>
    </div>

    <div style={{ padding: '8px 6px', overflowY: 'auto', flex: 1 }}>
      {/* Today */}
      <div style={{ padding: '6px 4px 2px 4px' }}>
        <SidebarItem icon="sun" label="today — jan 14" active={active === 'today'} onClick={() => onSelect?.('today')} />
        <SidebarItem icon="inbox" label="inbox" count={3} active={active === 'inbox'} onClick={() => onSelect?.('inbox')} />
      </div>

      <SidebarHeading>pinned</SidebarHeading>
      <SidebarItem icon="book-open" label="serre spectral sequences" active={active === 'serre'} onClick={() => onSelect?.('serre')}/>
      <SidebarItem icon="file-text" label="hatcher ch. 5 — reading" />
      <SidebarItem icon="presentation" label="lecture 9 — fibrations" />

      <SidebarHeading>saved searches</SidebarHeading>
      <SidebarItem icon="circle-help" label="open questions" count={12} accent="var(--type-question)" />
      <SidebarItem icon="zap-off" label="unresolved tensions" count={3} accent="var(--status-wtf)" />
      <SidebarItem icon="sparkles" label="beginner-mind" count={7} accent="var(--beginner-mind)" />
      <SidebarItem icon="link-2" label="lonely blocks · 30d+" count={4} />

      <SidebarHeading>supertags</SidebarHeading>
      <SidebarItem icon="hash" label="theorem" count={48}/>
      <SidebarItem icon="hash" label="lemma" count={31}/>
      <SidebarItem icon="hash" label="example" count={66}/>
      <SidebarItem icon="hash" label="paper" count={14}/>
      <SidebarItem icon="hash" label="lecture" count={22}/>

      <SidebarHeading>topics</SidebarHeading>
      <SidebarItem icon="folder" label="algebraic topology" indent={0}/>
      <SidebarItem label="spectral sequences" indent={1}/>
      <SidebarItem label="fibrations" indent={1}/>
      <SidebarItem icon="folder" label="differential geometry" indent={0}/>
      <SidebarItem icon="folder" label="cat theory" indent={0}/>
    </div>

    {/* Footer */}
    <div style={{ borderTop: '1px solid var(--border-0)', padding: 8 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 6px', borderRadius: 'var(--r-2)', cursor: 'pointer',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          background: 'linear-gradient(135deg,#1E1E1E,#444)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600,
        }}>MP</div>
        <span style={{ fontSize: 13, color: 'var(--fg-1)', flex: 1 }}>m. perlmann</span>
        <Icon name="chevron-up" size={14} style={{ color: 'var(--fg-3)' }}/>
      </div>
    </div>
  </aside>
);

Object.assign(window, { Sidebar, SidebarItem, SidebarHeading });
