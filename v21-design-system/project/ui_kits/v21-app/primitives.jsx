// ============================================================
// v21 — Primitives
// Buttons, chips, key caps, dividers. Tiny, presentational.
// ============================================================

const Icon = ({ name, size = 16, color, strokeWidth, style, ...rest }) => {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const node = ref.current;
    if (!window.lucide || !node) return;
    // Replace the host node's contents with the inline SVG ourselves so we
    // don't rely on lucide's global DOM rewrite (which detaches React refs).
    const spec = window.lucide.icons && (
      window.lucide.icons[name] ||
      window.lucide.icons[name.replace(/(^\w|-\w)/g, m => m.replace('-','').toUpperCase())]
    );
    if (!spec) return;
    // spec is [tag, attrs, children] OR for newer versions, a function/object.
    // Use createElement on lucide's helper if available:
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const attrs = Array.isArray(spec) ? spec[1] : (spec.attrs || {
        xmlns: 'http://www.w3.org/2000/svg', width: 24, height: 24,
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      });
      Object.entries(attrs).forEach(([k,v]) => svg.setAttribute(k, v));
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
      svg.setAttribute('stroke-width', strokeWidth || (size <= 14 ? 1.75 : 1.5));
      const children = Array.isArray(spec) ? spec[2] : (spec.children || []);
      children.forEach(([tag, a]) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(a || {}).forEach(([k,v]) => el.setAttribute(k, v));
        svg.appendChild(el);
      });
      node.textContent = '';
      node.appendChild(svg);
    } catch (e) {}
  });
  return (
    <i
      ref={ref}
      style={{
        width: size,
        height: size,
        color: color || 'currentColor',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        ...style,
      }}
      {...rest}
    />
  );
};

const KBD = ({ children, style }) => (
  <span
    style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 5px',
      minWidth: 18,
      height: 18,
      borderRadius: 'var(--r-1)',
      background: 'var(--bg-2)',
      color: 'var(--fg-1)',
      border: '1px solid var(--border-0)',
      borderBottomWidth: 2,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      ...style,
    }}
  >
    {children}
  </span>
);

const Btn = ({ variant = 'ghost', size = 'md', leading, trailing, children, style, ...rest }) => {
  const base = {
    appearance: 'none',
    border: 0,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    letterSpacing: 0,
    borderRadius: 'var(--r-2)',
    transition: `background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out)`,
    padding: size === 'sm' ? '4px 8px' : size === 'lg' ? '8px 14px' : '6px 10px',
    fontSize: size === 'sm' ? 12 : 14,
    height: size === 'sm' ? 24 : size === 'lg' ? 36 : 28,
  };
  const variants = {
    primary: { background: 'var(--accent)', color: '#fff' },
    secondary: { background: 'var(--bg-2)', color: 'var(--fg-0)' },
    ghost: { background: 'transparent', color: 'var(--fg-1)' },
    outline: { background: 'transparent', color: 'var(--fg-0)', boxShadow: 'inset 0 0 0 1px var(--border-1)' },
  };
  const hover = {
    primary: 'var(--accent-hover)',
    secondary: 'var(--bg-3)',
    ghost: 'var(--bg-2)',
    outline: 'var(--bg-2)',
  };
  return (
    <button
      {...rest}
      style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={(e) => (e.currentTarget.style.background = hover[variant])}
      onMouseLeave={(e) => (e.currentTarget.style.background = variants[variant].background)}
    >
      {leading && <Icon name={leading} size={size === 'sm' ? 12 : 14} />}
      {children}
      {trailing && <Icon name={trailing} size={size === 'sm' ? 12 : 14} />}
    </button>
  );
};

const IconBtn = ({ name, size = 28, iconSize = 16, title, active, style, ...rest }) => (
  <button
    title={title}
    {...rest}
    style={{
      width: size,
      height: size,
      borderRadius: 'var(--r-2)',
      border: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      background: active ? 'var(--bg-3)' : 'transparent',
      color: active ? 'var(--fg-0)' : 'var(--fg-2)',
      transition: 'background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out)',
      ...style,
    }}
    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.color = 'var(--fg-0)'; }}
    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = active ? 'var(--fg-0)' : 'var(--fg-2)'; }}
  >
    <Icon name={name} size={iconSize} />
  </button>
);

// Status chip — 6px dot + label, used inline on bubbles
const STATUS_META = {
  wtf:       { color: 'var(--status-wtf)',       label: 'wtf' },
  gap:       { color: 'var(--status-gap)',       label: 'gap' },
  seedling:  { color: 'var(--status-seedling)',  label: 'seedling' },
  working:   { color: 'var(--status-working)',   label: 'working' },
  confident: { color: 'var(--status-confident)', label: 'confident' },
  settled:   { color: 'var(--status-settled)',   label: 'settled' },
  parked:    { color: 'var(--status-parked)',    label: 'parked' },
  open:      { color: 'var(--type-question)',    label: 'open' },
  answered:  { color: 'var(--status-confident)', label: 'answered' },
};

const StatusChip = ({ status }) => {
  const m = STATUS_META[status];
  if (!m) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--fg-2)', fontSize: 12, lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, flex: '0 0 auto' }} />
      {m.label}
    </span>
  );
};

const Tag = ({ children, color = 'var(--fg-2)', style }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      lineHeight: '18px',
      padding: '0 6px',
      height: 18,
      borderRadius: 'var(--r-1)',
      color,
      background: 'var(--bg-2)',
      letterSpacing: 0,
      ...style,
    }}
  >
    {children}
  </span>
);

const TopicTag = ({ children }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--fg-2)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
    <span style={{ color: 'var(--fg-3)' }}>#</span>{children}
  </span>
);

// Edge pill — used to mark a block as connected to another
const EdgePill = ({ type, target }) => {
  const colors = {
    supports:        'var(--status-confident)',
    contradicts:     'var(--status-wtf)',
    'prerequisite-of':'var(--accent)',
    generalizes:     'var(--accent)',
    'analogous-to':  'var(--type-source)',
    addresses:       'var(--type-question)',
  };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)',
      padding: '2px 6px', borderRadius: 'var(--r-1)',
      background: 'var(--bg-2)',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: colors[type] || 'var(--fg-2)' }}/>
      {type} <span style={{ color: 'var(--fg-1)' }}>→ {target}</span>
    </span>
  );
};

const Divider = ({ style }) => (
  <div style={{ height: 1, background: 'var(--border-0)', ...style }} />
);

// Thought-type marker (left rail color on a bubble)
const TypeRail = ({ type, beginnerMind }) => {
  const color =
    beginnerMind ? 'var(--beginner-mind)' :
    type === 'question' ? 'var(--type-question)' :
    type === 'source' ? 'var(--type-source)' :
    'transparent';
  return (
    <span style={{
      position: 'absolute', left: 0, top: 10, bottom: 10, width: 2,
      borderRadius: 1, background: color,
    }}/>
  );
};

// Export for cross-script use
Object.assign(window, { Icon, KBD, Btn, IconBtn, StatusChip, Tag, TopicTag, EdgePill, Divider, TypeRail, STATUS_META });
