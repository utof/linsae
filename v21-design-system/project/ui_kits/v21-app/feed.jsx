// ============================================================
// v21 — Note bubble + Feed
// The Telegram-like chronological view. Each block is a bubble
// with a thought-type rail, status chip, time, and actions on hover.
// ============================================================

// A single bubble. Aligned to the LEFT (this is a personal app — every
// message is yours; Telegram-style right-alignment of "my" messages
// would be redundant).
const NoteBubble = ({ block, onAction }) => {
  const [hover, setHover] = React.useState(false);
  const isQuestion = block.type === 'question';
  const isSource = block.type === 'source';

  // Bubble background:
  //  - questions: a faint amber tint
  //  - sources: a faint violet tint
  //  - beginner-mind: a faint pink tint regardless of type
  //  - claim / plain: white
  let bg = '#fff';
  if (block.beginnerMind) bg = '#FDF2F8';
  else if (isQuestion) bg = '#FFFBF0';
  else if (isSource) bg = '#FBF7FE';

  return (
    <div
      data-comment-anchor={block.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex', gap: 8,
        padding: '2px 0',
      }}
    >
      {/* Gutter — time (only on first bubble of a minute-group is conceptually right,
          but we'll show it on hover to keep the timeline quiet) */}
      <div style={{
        width: 44, flex: '0 0 auto',
        fontSize: 11, fontFamily: 'var(--font-mono)',
        color: hover ? 'var(--fg-2)' : 'var(--fg-3)',
        paddingTop: 12, textAlign: 'right', userSelect: 'none',
        transition: 'color var(--dur-2) var(--ease-out)',
      }}>{block.time}</div>

      {/* Bubble */}
      <div style={{
        position: 'relative',
        flex: '0 1 auto',
        maxWidth: 560,
        background: bg,
        borderRadius: 'var(--r-5)',
        border: '1px solid ' + (
          block.beginnerMind ? '#FBCFE8' :
          isQuestion ? '#FAEAC2' :
          isSource ? '#EFE0FB' :
          'var(--border-0)'
        ),
        padding: '10px 14px',
      }}>
        <TypeRail type={block.type} beginnerMind={block.beginnerMind}/>

        {/* Header line: type marker + status + tags + actions (on hover) */}
        {(block.type !== 'paragraph' || block.status || block.topics?.length) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            marginBottom: 6, color: 'var(--fg-2)',
          }}>
            {isQuestion && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'var(--type-question)',
                letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon name="circle-help" size={11} strokeWidth={2}/>
                question
              </span>
            )}
            {isSource && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'var(--type-source)',
                letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon name="bookmark" size={11} strokeWidth={2}/>
                source
              </span>
            )}
            {block.beginnerMind && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'var(--beginner-mind)',
                letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon name="sparkles" size={11} strokeWidth={2}/>
                first-pass
              </span>
            )}
            {block.status && <StatusChip status={block.status}/>}
            {block.topics?.map(t => <TopicTag key={t}>{t}</TopicTag>)}
          </div>
        )}

        {/* Body */}
        <div style={{
          fontFamily: isQuestion ? 'var(--font-serif)' : 'var(--font-sans)',
          fontStyle: isQuestion ? 'italic' : 'normal',
          fontSize: isQuestion ? 16 : 14,
          lineHeight: 'var(--lh-normal)',
          color: 'var(--fg-0)',
          letterSpacing: isQuestion ? 0.005 : 0,
        }}>
          {block.body}
        </div>

        {/* Math block */}
        {block.math && (
          <div style={{
            marginTop: 8,
            padding: '10px 14px',
            background: 'var(--bg-1)',
            border: '1px solid var(--border-0)',
            borderRadius: 'var(--r-3)',
            fontFamily: 'var(--font-mono)', fontSize: 14,
            color: 'var(--fg-0)', letterSpacing: 0,
            overflowX: 'auto',
          }}>
            {block.math}
          </div>
        )}

        {/* Source meta */}
        {isSource && block.source && (
          <div style={{
            marginTop: 6,
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, color: 'var(--fg-2)', fontFamily: 'var(--font-mono)',
          }}>
            <Icon name="file-text" size={12}/>
            <span>{block.source.cite}</span>
            <span style={{ color: 'var(--fg-3)' }}>·</span>
            <span>{block.source.anchor}</span>
          </div>
        )}

        {/* Edges */}
        {block.edges?.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {block.edges.map((e, i) => <EdgePill key={i} type={e.type} target={e.target}/>)}
          </div>
        )}

        {/* Action bar (hover) */}
        <div style={{
          position: 'absolute', top: -10, right: 10,
          display: 'flex', gap: 2,
          background: '#fff',
          border: '1px solid var(--border-0)',
          borderRadius: 'var(--r-2)',
          padding: 2,
          opacity: hover ? 1 : 0,
          transform: hover ? 'translateY(0)' : 'translateY(2px)',
          transition: 'opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out)',
          pointerEvents: hover ? 'auto' : 'none',
          boxShadow: 'var(--shadow-1)',
        }}>
          <IconBtn name="reply" size={22} iconSize={12} title="reply"/>
          <IconBtn name="link-2" size={22} iconSize={12} title="link"/>
          <IconBtn name="hash" size={22} iconSize={12} title="add supertag"/>
          <IconBtn name="circle-check" size={22} iconSize={12} title="set status"/>
          <IconBtn name="more-horizontal" size={22} iconSize={12} title="more"/>
        </div>
      </div>
    </div>
  );
};

// Day separator. Sticky on scroll.
const DaySeparator = ({ label, sublabel }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '20px 0 12px 0',
    position: 'sticky', top: 0,
    background: 'linear-gradient(to bottom, var(--bg-0) 70%, rgba(255,255,255,0))',
    zIndex: 2,
  }}>
    <div style={{ width: 44 }}/>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-0)' }}>{label}</span>
      {sublabel && <span style={{ fontSize: 12, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>{sublabel}</span>}
    </div>
    <div style={{ flex: 1, height: 1, background: 'var(--border-0)' }}/>
  </div>
);

// A free-standing prose paragraph (no bubble) — for the user's writing.
// Renders inline like a journal entry.
const ProseBlock = ({ block }) => (
  <div style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
    <div style={{
      width: 44, fontSize: 11, fontFamily: 'var(--font-mono)',
      color: 'var(--fg-3)', paddingTop: 2, textAlign: 'right',
    }}>{block.time}</div>
    <div style={{
      flex: 1, maxWidth: 560,
      fontSize: 14, lineHeight: 'var(--lh-normal)', color: 'var(--fg-1)',
    }}>{block.body}</div>
  </div>
);

// The whole feed
const Feed = ({ days }) => (
  <div style={{
    flex: 1, overflowY: 'auto', minHeight: 0,
    padding: '0 32px 24px 32px',
    background: 'var(--bg-0)',
  }}>
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {days.map((day, di) => (
        <section key={di} data-screen-label={`day-${day.id}`}>
          <DaySeparator label={day.label} sublabel={day.sublabel}/>
          {day.blocks.map((b, bi) => (
            b.type === 'prose'
              ? <ProseBlock key={b.id} block={b}/>
              : <NoteBubble key={b.id} block={b}/>
          ))}
        </section>
      ))}
    </div>
  </div>
);

Object.assign(window, { NoteBubble, DaySeparator, ProseBlock, Feed });
