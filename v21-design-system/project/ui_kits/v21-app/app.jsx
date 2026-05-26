// ============================================================
// v21 — App entry. Wires sidebar + topbar + feed + composer +
// right pane + command palette together. Sample math content.
// ============================================================

const SAMPLE_DAYS = [
  {
    id: '2026-01-14', label: 'today', sublabel: 'wed · jan 14',
    blocks: [
      { id: 'b1', type: 'paragraph', time: '09:14',
        body: 'starting on serre spectral sequences. trying to get a feel for when collapse actually happens.' },

      { id: 'b2', type: 'question', time: '09:18',
        body: 'why does the spectral sequence for this fibration collapse on E₂ ?',
        status: 'working',
        topics: ['algtop/serre', 'fibrations'] },

      { id: 'b3', type: 'claim', time: '09:22',
        body: 'if the base B is simply connected, the local coefficient system on H*(F) is trivial.',
        status: 'confident',
        topics: ['algtop/serre'],
        edges: [{ type: 'prerequisite-of', target: 'collapse-on-E2' }] },

      { id: 'b4', type: 'source', time: '09:30',
        body: 'hatcher §5.3 — discussion of the local coefficient subtlety, with the example of the Möbius band fibration.',
        source: { cite: 'Hatcher, Algebraic Topology', anchor: 'p. 187' },
        topics: ['hatcher.ch5'] },

      { id: 'b5', type: 'paragraph', time: '09:34',
        body: "ok so simply-connected ⇒ trivial coefficients. but the collapse question is different — that's about d₂ vanishing, not about coefficients." },

      { id: 'b6', type: 'question', time: '10:02', beginnerMind: true,
        body: 'what is a fibration intuitively, before any of the formalism?',
        status: 'parked',
        topics: ['algtop'] },

      { id: 'b7', type: 'claim', time: '10:11',
        body: 'collapse on the r-th page means d_r = 0 (and all higher differentials too), which means E_r = E_∞.',
        math: 'E₂^{p,q} ⇒ Hᵖ⁺ᑫ(E;ℤ),    d₂ : E₂^{p,q} → E₂^{p+2,q-1}',
        status: 'confident',
        topics: ['algtop/serre'],
        edges: [
          { type: 'addresses', target: 'why does it collapse on E_2?' },
          { type: 'supports',  target: 'E_2 = E_∞ when d_2 = 0' },
        ] },

      { id: 'b8', type: 'paragraph', time: '11:45',
        body: 'rewatching lec 9, around 23 min mark — the dimension argument she gives is cleaner than i remembered.' },

      { id: 'b9', type: 'source', time: '11:46',
        body: 'lecture 9, math 232B — fibrations, day 2.',
        source: { cite: 'lec.9 · math 232B', anchor: '23:14' },
        topics: ['lecture.9'] },

      { id: 'b10', type: 'question', time: '13:20',
        body: 'is "collapse at E_2" always equivalent to "the spectral sequence has only one nonzero column"?',
        status: 'open',
        topics: ['algtop/serre'],
        edges: [{ type: 'contradicts', target: 'two-column counterexample' }] },
    ]
  },
  {
    id: '2026-01-13', label: 'yesterday', sublabel: 'tue · jan 13',
    blocks: [
      { id: 'y1', type: 'paragraph', time: '08:42',
        body: 'morning: re-reading hatcher chapter 5 intro. taking it slow.' },

      { id: 'y2', type: 'claim', time: '09:01',
        body: 'a Serre fibration is a map p:E→B with the homotopy lifting property for CW pairs.',
        status: 'settled', topics: ['algtop/fibrations'] },

      { id: 'y3', type: 'question', time: '09:18',
        body: "does the HLP need to hold for *all* spaces or just CW? matters for the proofs later.",
        status: 'answered',
        topics: ['algtop/fibrations'] },

      { id: 'y4', type: 'paragraph', time: '14:55',
        body: "study session w/ K. she explained the difference between a fiber bundle and a fibration in like one sentence and now i don't know how i was confused before." },
    ]
  },
];

const App = () => {
  const [active, setActive] = React.useState('today');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [composerMode, setComposerMode] = React.useState('paragraph');
  const [days, setDays] = React.useState(SAMPLE_DAYS);

  // Open palette on ⌘K
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Run lucide on first paint
  React.useEffect(() => {
    const t = setTimeout(() => window.lucide?.createIcons(), 50);
    return () => clearTimeout(t);
  }, [active, paletteOpen, composerMode]);

  const onCapture = ({ mode, body }) => {
    const blocks = days[0].blocks.slice();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    blocks.push({
      id: `new-${Date.now()}`,
      type: mode === 'paragraph' ? 'paragraph' : mode,
      time, body,
      status: mode === 'question' ? 'open' : mode === 'claim' ? 'working' : undefined,
    });
    setDays([{ ...days[0], blocks }, ...days.slice(1)]);
  };

  return (
    <div className="v21" style={{ display: 'flex', height: '100vh', background: 'var(--bg-0)', overflow: 'hidden' }} data-screen-label="01 chronological-feed">
      <Sidebar active={active} onSelect={setActive}/>
      <main style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <Topbar onOpenPalette={() => setPaletteOpen(true)}/>
        <Feed days={days}/>
        <Composer mode={composerMode} onChangeMode={setComposerMode} onSubmit={onCapture}/>
      </main>
      <RightPane/>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)}/>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
