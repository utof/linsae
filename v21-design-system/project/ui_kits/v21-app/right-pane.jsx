// ============================================================
// v21 — Right pane: backlinks + connections + AI
// Hidden by default; surfaces when the user focuses a block.
// ============================================================

const PaneTab = ({ active, label, count, onClick }) => (
  <button onClick={onClick} style={{
    border: 0, background: 'transparent', cursor: 'pointer',
    padding: '10px 4px', marginRight: 14,
    fontSize: 13, fontWeight: active ? 600 : 400,
    color: active ? 'var(--fg-0)' : 'var(--fg-2)',
    borderBottom: '2px solid ' + (active ? 'var(--fg-0)' : 'transparent'),
    display: 'inline-flex', alignItems: 'center', gap: 6,
  }}>
    {label}
    {count != null && <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>{count}</span>}
  </button>
);

const BacklinkRow = ({ topic, day, snippet, edgeType }) => (
  <div style={{
    padding: '10px 14px', borderRadius: 'var(--r-3)',
    border: '1px solid var(--border-0)', background: '#fff',
    marginBottom: 8, cursor: 'pointer',
    transition: 'background var(--dur-2) var(--ease-out)',
  }}
    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-1)'}
    onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
  >
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginBottom: 6, fontSize: 11, color: 'var(--fg-2)', fontFamily: 'var(--font-mono)',
    }}>
      <span>{day}</span>
      <span style={{ color: 'var(--fg-3)' }}>·</span>
      <TopicTag>{topic}</TopicTag>
      {edgeType && (
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--status-confident)' }}/>
          {edgeType}
        </span>
      )}
    </div>
    <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 'var(--lh-normal)' }}>{snippet}</div>
  </div>
);

const RightPane = () => {
  const [tab, setTab] = React.useState('backlinks');
  return (
    <aside style={{
      width: 'var(--right-pane-w)', flex: '0 0 auto',
      borderLeft: '1px solid var(--border-0)',
      background: 'var(--bg-1)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
    }}>
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border-0)',
        background: '#fff', minHeight: 'var(--topbar-h)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--fg-2)', letterSpacing: 'var(--tracking-mega)', textTransform: 'uppercase', fontWeight: 500 }}>focused block</div>
          <div style={{ fontSize: 13, color: 'var(--fg-0)', marginTop: 2 }}>"collapse means d₂ = 0…"</div>
        </div>
        <IconBtn name="x" title="close pane"/>
      </div>

      <div style={{ borderBottom: '1px solid var(--border-0)', padding: '0 14px', background: '#fff' }}>
        <PaneTab active={tab === 'backlinks'} label="backlinks" count={7} onClick={() => setTab('backlinks')}/>
        <PaneTab active={tab === 'edges'} label="edges" count={4} onClick={() => setTab('edges')}/>
        <PaneTab active={tab === 'ai'} label="ai" onClick={() => setTab('ai')}/>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: 12 }}>
        {tab === 'backlinks' && (
          <>
            <div style={{
              display: 'flex', gap: 6, marginBottom: 10,
            }}>
              <Btn size="sm" variant="outline" leading="filter">all edges</Btn>
              <Btn size="sm" variant="outline">recency</Btn>
            </div>
            <BacklinkRow day="dec 22" topic="serre" edgeType="supports"
              snippet="If d_r = 0 for all r ≥ R, the spectral sequence collapses at the R-th page and E_R = E_∞."/>
            <BacklinkRow day="dec 18" topic="hatcher.5.3"
              snippet="Hatcher's definition: a fibration is a map with the homotopy lifting property…"/>
            <BacklinkRow day="dec 14" topic="lecture.9" edgeType="prerequisite-of"
              snippet="Define E_2 = H^p(B; H^q(F)). The collapse question reduces to vanishing of the d_2 differential."/>
            <BacklinkRow day="dec 11" topic="serre"
              snippet="Open question — when is the local coefficient system trivial?"/>
          </>
        )}
        {tab === 'edges' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <EdgePill type="supports" target="d_r = 0 implies E_R = E_∞"/>
            <EdgePill type="addresses" target="why does it collapse on E_2?"/>
            <EdgePill type="prerequisite-of" target="convergence of Serre SS"/>
            <EdgePill type="analogous-to" target="Leray SS for sheaves"/>
          </div>
        )}
        {tab === 'ai' && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 10 }}>narrow, on-demand actions. nothing runs in the background.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Btn variant="outline" leading="wand-2" size="md" style={{ justifyContent: 'flex-start', width: '100%' }}>explain at level X</Btn>
              <Btn variant="outline" leading="wand-2" size="md" style={{ justifyContent: 'flex-start', width: '100%' }}>contrastive counter-example</Btn>
              <Btn variant="outline" leading="wand-2" size="md" style={{ justifyContent: 'flex-start', width: '100%' }}>3 flashcards from this block</Btn>
              <Btn variant="outline" leading="wand-2" size="md" style={{ justifyContent: 'flex-start', width: '100%' }}>find similar past notes</Btn>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

Object.assign(window, { RightPane });
