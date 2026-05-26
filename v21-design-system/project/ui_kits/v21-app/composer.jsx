// ============================================================
// v21 — Composer (sticky bottom, inline within the daily note)
// One-keystroke promotion to Question/Claim/Source via Q/C/S.
// ============================================================

const ComposerHint = ({ k, label, color }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 11, color: 'var(--fg-2)',
  }}>
    <KBD>{k}</KBD>
    <span style={{ color }}>{label}</span>
  </span>
);

const Composer = ({ onSubmit, mode = 'paragraph', onChangeMode }) => {
  const [value, setValue] = React.useState('');
  const ref = React.useRef(null);

  const placeholder =
    mode === 'question' ? 'ask a question…' :
    mode === 'claim'    ? 'state a claim…' :
    mode === 'source'   ? 'paste a citation, page, or timestamp…' :
                          'write — or press q / c / s to promote';

  const accent =
    mode === 'question' ? 'var(--type-question)' :
    mode === 'claim'    ? 'var(--accent)' :
    mode === 'source'   ? 'var(--type-source)' :
                          'var(--border-1)';

  // Keystroke promotion when the composer is empty
  const onKeyDown = (e) => {
    if (value.length === 0 && ['q','c','s'].includes(e.key.toLowerCase()) && !e.metaKey && !e.ctrlKey) {
      const m = { q: 'question', c: 'claim', s: 'source' }[e.key.toLowerCase()];
      if (mode === 'paragraph') {
        e.preventDefault();
        onChangeMode?.(m);
        return;
      }
    }
    if (e.key === 'Escape') {
      onChangeMode?.('paragraph');
      setValue('');
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSubmit?.({ mode, body: value });
        setValue('');
        onChangeMode?.('paragraph');
      }
    }
  };

  return (
    <div style={{
      flex: '0 0 auto',
      padding: '12px 32px 24px 32px',
      background: 'var(--bg-0)',
      borderTop: '1px solid var(--border-0)',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto', paddingLeft: 52 /* align with bubble column */ }}>
      <div style={{
        background: '#fff',
        border: '1px solid ' + accent,
        boxShadow: 'var(--shadow-2)',
        borderRadius: 'var(--r-4)',
        padding: '10px 12px 8px 12px',
        transition: 'border-color var(--dur-2) var(--ease-out)',
      }}>
        {/* Mode pill */}
        {mode !== 'paragraph' && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            marginBottom: 6, padding: '2px 8px',
            borderRadius: 'var(--r-1)',
            background: accent, color: '#fff',
            fontSize: 11, fontWeight: 600, letterSpacing: 'var(--tracking-wide)',
            textTransform: 'uppercase',
          }}>
            <Icon
              name={mode === 'question' ? 'circle-help' : mode === 'source' ? 'bookmark' : 'circle'}
              size={11} strokeWidth={2.4}
            />
            {mode}
            <span style={{
              marginLeft: 4, opacity: 0.85, fontFamily: 'var(--font-mono)',
              fontWeight: 400, textTransform: 'lowercase',
            }}>esc to clear</span>
          </div>
        )}

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={mode === 'paragraph' ? 1 : 2}
          style={{
            width: '100%', border: 0, outline: 'none',
            resize: 'none',
            fontFamily: mode === 'question' ? 'var(--font-serif)' : 'var(--font-sans)',
            fontStyle: mode === 'question' ? 'italic' : 'normal',
            fontSize: mode === 'question' ? 16 : 14,
            lineHeight: 'var(--lh-normal)',
            color: 'var(--fg-0)',
            background: 'transparent',
          }}
        />

        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          paddingTop: 6, borderTop: '1px dashed var(--border-0)',
          marginTop: 4,
        }}>
          {mode === 'paragraph' ? (
            <>
              <ComposerHint k="Q" label="question" color="var(--type-question)"/>
              <ComposerHint k="C" label="claim" color="var(--accent)"/>
              <ComposerHint k="S" label="source" color="var(--type-source)"/>
              <span style={{ width: 1, height: 12, background: 'var(--border-0)' }}/>
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                <KBD>/</KBD> commands  ·  <KBD>$</KBD> math  ·  <KBD>#</KBD> tag
              </span>
            </>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
              <KBD>↵</KBD> capture  ·  <KBD>⇧</KBD><KBD>↵</KBD> newline  ·  <KBD>esc</KBD> back to paragraph
            </span>
          )}
          <div style={{ flex: 1 }}/>
          <IconBtn name="paperclip" iconSize={14} title="attach"/>
          <IconBtn name="image" iconSize={14} title="paste image"/>
          <IconBtn name="pen-tool" iconSize={14} title="open ink panel"/>
          <Btn variant={value.trim() ? 'primary' : 'secondary'} size="sm" trailing="corner-down-left" onClick={() => {
            if (value.trim()) { onSubmit?.({ mode, body: value }); setValue(''); onChangeMode?.('paragraph'); }
          }}>
            capture
          </Btn>
        </div>
      </div>
      </div>
    </div>
  );
};

Object.assign(window, { Composer });
