// ============================================================
// v21 — Command palette (⌘K)
// Capture, jump, run query, set status, run AI action.
// ============================================================

const PALETTE_ITEMS = [
  { group: 'capture',  icon: 'circle-help', label: 'new question',                shortcut: ['Q'] },
  { group: 'capture',  icon: 'circle',      label: 'new claim',                   shortcut: ['C'] },
  { group: 'capture',  icon: 'bookmark',    label: 'new source',                  shortcut: ['S'] },
  { group: 'jump',     icon: 'sun',         label: "today's daily note",          shortcut: ['G','T'] },
  { group: 'jump',     icon: 'inbox',       label: 'inbox',                       shortcut: ['G','I'] },
  { group: 'jump',     icon: 'calendar',    label: 'jump to date…',               shortcut: [] },
  { group: 'queries',  icon: 'circle-help', label: 'open questions',              shortcut: [] },
  { group: 'queries',  icon: 'zap-off',     label: 'unresolved tensions',         shortcut: [] },
  { group: 'queries',  icon: 'sparkles',    label: 'beginner-mind questions',     shortcut: [] },
  { group: 'queries',  icon: 'link-2',      label: 'lonely blocks · 30d+',        shortcut: [] },
  { group: 'ai',       icon: 'wand-2',      label: 'ai · explain at level X',     shortcut: [] },
  { group: 'ai',       icon: 'wand-2',      label: 'ai · generate flashcards',    shortcut: [] },
  { group: 'ai',       icon: 'wand-2',      label: 'ai · weekly trajectory digest',shortcut: [] },
];

const CommandPalette = ({ open, onClose }) => {
  const [q, setQ] = React.useState('');
  const filtered = PALETTE_ITEMS.filter(i => i.label.toLowerCase().includes(q.toLowerCase()));
  const grouped = {};
  filtered.forEach(i => { (grouped[i.group] = grouped[i.group] || []).push(i); });

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(30,30,30,0.20)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '12vh', zIndex: 100,
        animation: 'paletteFadeIn 220ms var(--ease-out)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxHeight: '70vh', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          background: '#fff',
          borderRadius: 'var(--r-4)',
          boxShadow: 'var(--shadow-3)',
          animation: 'paletteRise 220ms var(--ease-out)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px',
          borderBottom: '1px solid var(--border-0)',
        }}>
          <Icon name="search" size={16} style={{ color: 'var(--fg-2)' }}/>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search, jump, capture…"
            style={{
              flex: 1, border: 0, outline: 'none',
              fontSize: 15, fontFamily: 'var(--font-sans)', color: 'var(--fg-0)',
            }}
          />
          <KBD>esc</KBD>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 6px 10px 6px' }}>
          {Object.entries(grouped).map(([group, items]) => (
            <div key={group}>
              <div style={{
                padding: '10px 12px 4px 12px',
                fontSize: 11, letterSpacing: 'var(--tracking-mega)', textTransform: 'uppercase',
                color: 'var(--fg-2)', fontWeight: 500,
              }}>{group}</div>
              {items.map((item, i) => (
                <button
                  key={item.label}
                  style={{
                    width: '100%', border: 0, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 'var(--r-2)',
                    background: i === 0 && group === Object.keys(grouped)[0] ? 'var(--bg-2)' : 'transparent',
                    color: 'var(--fg-0)', fontSize: 14, textAlign: 'left',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                  onMouseLeave={(e) => {
                    const first = i === 0 && group === Object.keys(grouped)[0];
                    e.currentTarget.style.background = first ? 'var(--bg-2)' : 'transparent';
                  }}
                >
                  <Icon name={item.icon} size={16} style={{ color: 'var(--fg-2)' }}/>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.shortcut.length > 0 && (
                    <span style={{ display: 'flex', gap: 4 }}>
                      {item.shortcut.map((s, j) => <KBD key={j}>{s}</KBD>)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{
              padding: 24, textAlign: 'center',
              color: 'var(--fg-2)', fontSize: 13,
            }}>nothing matches that. <span style={{ color: 'var(--fg-3)' }}>try a different word.</span></div>
          )}
        </div>

        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border-0)',
          background: 'var(--bg-1)',
          display: 'flex', gap: 14,
          fontSize: 11, color: 'var(--fg-2)',
        }}>
          <span><KBD>↑</KBD><KBD>↓</KBD> navigate</span>
          <span><KBD>↵</KBD> select</span>
          <span><KBD>⌘</KBD><KBD>↵</KBD> open in new pane</span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>v21 ⌘K</span>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { CommandPalette });
